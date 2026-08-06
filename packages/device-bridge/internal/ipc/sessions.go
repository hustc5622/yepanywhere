package ipc

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hustc5622/yepanywhere/device-bridge/internal/device"
	"github.com/hustc5622/yepanywhere/device-bridge/internal/encoder"
	"github.com/hustc5622/yepanywhere/device-bridge/internal/stream"
)

// SessionStartOptions are the options for starting a device streaming session.
type SessionStartOptions struct {
	MaxFPS   int `json:"maxFps"`
	MaxWidth int `json:"maxWidth"`
	Quality  int `json:"quality"` // x264 CRF value (0 = use default of 30)
}

// streamSession holds the state for a single active device streaming session.
type streamSession struct {
	sessionID   string
	deviceID    string
	maxWidth    int // for pool release key
	maxFPS      int
	frameSource *device.FrameSource // shared via pool, not owned
	nalSource   *device.NalSource
	streamCap   device.StreamCapable
	enc         *encoder.H264Encoder
	peer        *stream.PeerSession
	input       *stream.InputHandler
	cancel      context.CancelFunc
	targetW     int
	targetH     int
	pipelineWg  sync.WaitGroup // tracks runPipeline goroutine lifetime
	fpsCh       chan int       // receives fps_hint values from the client DataChannel
}

// SessionManager manages multiple concurrent device streaming sessions.
type SessionManager struct {
	mu          sync.Mutex
	sessions    map[string]*streamSession
	stunServers []string
	sendMsg     func(msg []byte) // send JSON to the Yep server WebSocket
	pool        *ResourcePool    // shared device connections and FrameSources
	onIdle      func()           // called when no sessions remain for idleTimeout
	idleTimer   *time.Timer
	idleTimeout time.Duration
}

type adaptiveTuning struct {
	minBitrate              int
	mildQueueDepth          int
	moderateQueueDepth      int
	severeQueueDepth        int
	severeWindow            time.Duration
	restartDownWindow       time.Duration
	recoveryWindow          time.Duration
	restartUpWindow         time.Duration
	restartCooldown         time.Duration
	keyframeRequestBackoff  time.Duration
	bitrateChangeBackoff    time.Duration
	dropUntilKeyframe       bool
	writeDelay              time.Duration
	writeDelayDuration      time.Duration
	forceProfileCycle       bool
	forceDownAfter          time.Duration
	forceUpAfter            time.Duration
	nalInactivityProbe      time.Duration
	nalInactivityCloseAfter time.Duration
}

// NewSessionManager creates a session manager.
// onIdle is called when no sessions remain for 10 seconds (nil to disable).
func NewSessionManager(adbPath string, stunServers []string, sendMsg func(msg []byte), onIdle func()) *SessionManager {
	sm := &SessionManager{
		sessions:    make(map[string]*streamSession),
		stunServers: stunServers,
		sendMsg:     sendMsg,
		pool:        NewResourcePool(adbPath),
		onIdle:      onIdle,
		idleTimeout: 10 * time.Second,
	}
	// Start idle timer immediately (bridge starts with no sessions).
	if onIdle != nil {
		sm.idleTimer = time.AfterFunc(sm.idleTimeout, sm.handleIdle)
	}
	return sm
}

// handleIdle fires when the idle timer expires. Only triggers onIdle if still no sessions.
func (sm *SessionManager) handleIdle() {
	sm.mu.Lock()
	count := len(sm.sessions)
	sm.mu.Unlock()

	if count == 0 && sm.onIdle != nil {
		log.Printf("[SessionManager] idle for %v with no sessions, triggering shutdown", sm.idleTimeout)
		sm.onIdle()
	}
}

// resetIdleTimer must be called with sm.mu held.
func (sm *SessionManager) resetIdleTimer() {
	if sm.idleTimer == nil {
		return
	}
	if len(sm.sessions) > 0 {
		sm.idleTimer.Stop()
	} else {
		sm.idleTimer.Reset(sm.idleTimeout)
	}
}

// StartSession creates a new streaming session for the given device.
func (sm *SessionManager) StartSession(sessionID, deviceID, deviceType string, opts SessionStartOptions) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Close existing session with same ID.
	if existing, ok := sm.sessions[sessionID]; ok {
		sm.closeSessionLocked(existing)
	}

	sm.sendState(sessionID, "connecting", "")

	// Defaults.
	maxWidth := opts.MaxWidth
	if maxWidth <= 0 {
		maxWidth = 360
	}
	maxFPS := opts.MaxFPS
	if maxFPS <= 0 {
		maxFPS = 30
	}

	// Acquire shared device from pool.
	log.Printf("[session %s] connecting to device %s (type=%s)", sessionID, deviceID, deviceType)

	client, err := sm.pool.AcquireDevice(deviceID, deviceType)
	if err != nil {
		sm.sendState(sessionID, "failed", fmt.Sprintf("device connect: %v", err))
		return fmt.Errorf("connecting to device: %w", err)
	}

	srcW, srcH := client.ScreenSize()
	targetW, targetH := encoder.ComputeTargetSize(int(srcW), int(srcH), maxWidth)
	log.Printf("[session %s] screen %dx%d → encoding %dx%d", sessionID, srcW, srcH, targetW, targetH)

	var (
		frameSource *device.FrameSource
		nalSource   *device.NalSource
		streamCap   device.StreamCapable
		h264Enc     *encoder.H264Encoder
	)

	// Try Android hardware stream path first; fall back to JPEG+x264 on any failure.
	if ns, sc, streamErr := maybeStartAndroidStream(client, deviceType, targetW, targetH, maxFPS); streamErr == nil {
		nalSource = ns
		streamCap = sc
		if ns != nil {
			log.Printf("[session %s] using on-device MediaCodec stream (%dx%d @ %dfps)", sessionID, targetW, targetH, maxFPS)
		}
	} else {
		log.Printf("[session %s] stream_start unavailable, falling back to screenshot path: %v", sessionID, streamErr)
	}

	if nalSource == nil {
		h264Enc, err = encoder.NewH264Encoder(targetW, targetH, maxFPS, opts.Quality)
		if err != nil {
			sm.pool.ReleaseDevice(deviceID)
			sm.sendState(sessionID, "failed", fmt.Sprintf("encoder: %v", err))
			return fmt.Errorf("creating encoder: %w", err)
		}
		// Acquire shared FrameSource from pool only on screenshot mode.
		frameSource = sm.pool.AcquireFrameSource(deviceID, maxWidth, maxFPS, client)
	}

	inputHandler := stream.NewInputHandler(client)

	fpsCh := make(chan int, 1)

	// Wrap the DataChannel handler to intercept fps_hint messages before
	// forwarding everything else to the input handler.
	type fpshintMsg struct {
		Type string `json:"type"`
		FPS  int    `json:"fps"`
	}
	onMessage := func(msg []byte) {
		var peek fpshintMsg
		if json.Unmarshal(msg, &peek) == nil && peek.Type == "fps_hint" {
			if peek.FPS > 0 {
				select {
				case fpsCh <- peek.FPS:
				default: // drop if a hint is already pending
				}
			}
			return
		}
		inputHandler.HandleMessage(msg)
	}

	// Create WebRTC peer with trickle ICE.
	onICE := func(c *stream.ICECandidateJSON) {
		sm.sendICE(sessionID, c)
	}
	peer, err := stream.NewPeerSession(sessionID, sm.stunServers, onMessage, onICE)
	if err != nil {
		if frameSource != nil {
			sm.pool.ReleaseFrameSource(deviceID, maxWidth)
		}
		if h264Enc != nil {
			h264Enc.Close()
		}
		if streamCap != nil {
			_ = streamCap.StopStream(context.Background())
		}
		sm.pool.ReleaseDevice(deviceID)
		sm.sendState(sessionID, "failed", fmt.Sprintf("peer: %v", err))
		return fmt.Errorf("creating peer: %w", err)
	}

	sdp, err := peer.CreateOffer()
	if err != nil {
		peer.Close()
		if frameSource != nil {
			sm.pool.ReleaseFrameSource(deviceID, maxWidth)
		}
		if h264Enc != nil {
			h264Enc.Close()
		}
		if streamCap != nil {
			_ = streamCap.StopStream(context.Background())
		}
		sm.pool.ReleaseDevice(deviceID)
		sm.sendState(sessionID, "failed", fmt.Sprintf("offer: %v", err))
		return fmt.Errorf("creating offer: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	sess := &streamSession{
		sessionID:   sessionID,
		deviceID:    deviceID,
		maxWidth:    maxWidth,
		maxFPS:      maxFPS,
		frameSource: frameSource,
		nalSource:   nalSource,
		streamCap:   streamCap,
		enc:         h264Enc,
		peer:        peer,
		input:       inputHandler,
		cancel:      cancel,
		targetW:     targetW,
		targetH:     targetH,
		fpsCh:       fpsCh,
	}
	sm.sessions[sessionID] = sess
	sm.resetIdleTimer()

	// Monitor peer close.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[session %s] panic recovered in peer monitor: %v", sessionID, r)
			}
		}()
		select {
		case <-peer.Done():
			sm.mu.Lock()
			if s, ok := sm.sessions[sessionID]; ok && s == sess {
				sm.closeSessionLocked(sess)
				delete(sm.sessions, sessionID)
				sm.resetIdleTimer()
			}
			sm.mu.Unlock()
			sm.sendState(sessionID, "disconnected", "")
		case <-ctx.Done():
		}
	}()

	// Send the offer to the Yep server.
	sm.sendOffer(sessionID, sdp)

	return nil
}

// HandleAnswer processes an SDP answer for a session and starts the encoding pipeline.
func (sm *SessionManager) HandleAnswer(sessionID, sdp string) error {
	sm.mu.Lock()
	sess, ok := sm.sessions[sessionID]
	sm.mu.Unlock()

	if !ok {
		return fmt.Errorf("no session %s", sessionID)
	}

	if err := sess.peer.SetAnswer(sdp); err != nil {
		return fmt.Errorf("setting answer: %w", err)
	}

	// Start encoding pipeline.
	sess.pipelineWg.Add(1)
	go sm.runPipeline(sess)

	sm.sendState(sessionID, "connected", "")
	return nil
}

// HandleICE adds a remote ICE candidate to a session.
func (sm *SessionManager) HandleICE(sessionID string, candidateJSON json.RawMessage) error {
	sm.mu.Lock()
	sess, ok := sm.sessions[sessionID]
	sm.mu.Unlock()

	if !ok {
		return fmt.Errorf("no session %s", sessionID)
	}

	if string(candidateJSON) == "null" {
		// End-of-candidates signal; nothing to do on the Pion side.
		return nil
	}

	return sess.peer.AddICECandidate(candidateJSON)
}

// StopSession tears down a streaming session.
func (sm *SessionManager) StopSession(sessionID string) {
	sm.mu.Lock()
	sess, ok := sm.sessions[sessionID]
	if ok {
		sm.closeSessionLocked(sess)
		delete(sm.sessions, sessionID)
		sm.resetIdleTimer()
	}
	sm.mu.Unlock()

	if ok {
		sm.sendState(sessionID, "disconnected", "")
	}
}

// CloseAll tears down all sessions.
func (sm *SessionManager) CloseAll() {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	for id, sess := range sm.sessions {
		sm.closeSessionLocked(sess)
		delete(sm.sessions, id)
	}
	// Force-close any remaining pool resources (shouldn't be any after closeSessionLocked).
	sm.pool.CloseAll()
	sm.resetIdleTimer()
}

func (sm *SessionManager) closeSessionLocked(sess *streamSession) {
	sess.cancel()
	sess.peer.Close()
	// Wait for the pipeline goroutine to exit before freeing resources.
	sess.pipelineWg.Wait()

	if sess.streamCap != nil {
		_ = sess.streamCap.StopStream(context.Background())
	}
	if sess.enc != nil {
		// The x264 C library will crash (SIGSEGV/SIGABRT) if encoder is freed
		// while a concurrent encode call is in progress.
		sess.enc.Close()
	}
	// Release shared resources via pool (ref-counted).
	if sess.frameSource != nil {
		sm.pool.ReleaseFrameSource(sess.deviceID, sess.maxWidth)
	}
	sm.pool.ReleaseDevice(sess.deviceID)
	log.Printf("[session %s] closed", sess.sessionID)
	// Note: caller must call resetIdleTimer() after deleting from sm.sessions.
}

func (sm *SessionManager) runPipeline(sess *streamSession) {
	defer sess.pipelineWg.Done()
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[session %s] panic recovered in pipeline: %v", sess.sessionID, r)
		}
	}()

	// Wait for WebRTC connection before encoding frames.
	// Frames encoded before the connection is ready are silently dropped by Pion.
	log.Printf("[session %s] pipeline waiting for WebRTC connection", sess.sessionID)
	select {
	case <-sess.peer.Connected():
		log.Printf("[session %s] WebRTC connected, starting pipeline", sess.sessionID)
	case <-sess.peer.Done():
		log.Printf("[session %s] peer closed before connecting", sess.sessionID)
		return
	case <-time.After(30 * time.Second):
		log.Printf("[session %s] WebRTC connection timed out", sess.sessionID)
		return
	}

	if sess.nalSource != nil {
		sm.runNALPipeline(sess)
		return
	}

	id, frames := sess.frameSource.Subscribe()
	defer sess.frameSource.Unsubscribe(id)

	log.Printf("[session %s] pipeline started", sess.sessionID)
	defer log.Printf("[session %s] pipeline stopped", sess.sessionID)

	const activityTimeout = 15 * time.Second
	activityTimer := time.NewTimer(activityTimeout)
	defer activityTimer.Stop()

	// Pipeline stats for diagnostics.
	var (
		lastTime        time.Time
		framesReceived  uint64
		framesDrained   uint64
		framesEncoded   uint64
		framesWritten   uint64
		encodeErrors    uint64
		nilNals         uint64
		totalWriteBytes uint64
		statsStart      = time.Now()
	)

	// Rate-limit encoding to maxFPS. Without this, the polling loop feeds
	// frames as fast as gRPC delivers (~185 fps), producing excessive bitrate.
	currentFPS := sess.maxFPS
	frameInterval := time.Second / time.Duration(currentFPS)
	rateLimiter := time.NewTicker(frameInterval)
	defer rateLimiter.Stop()

	const statsInterval = 5 * time.Second
	statsTicker := time.NewTicker(statsInterval)
	defer statsTicker.Stop()

	logStats := func(reason string) {
		elapsed := time.Since(statsStart).Seconds()
		fps := float64(0)
		if elapsed > 0 {
			fps = float64(framesWritten) / elapsed
		}
		log.Printf("[session %s] stats (%s): recv=%d drained=%d encoded=%d written=%d nilNals=%d encErr=%d writeBytes=%d fps=%.1f elapsed=%.1fs conn=%s ice=%s",
			sess.sessionID, reason,
			framesReceived, framesDrained, framesEncoded, framesWritten, nilNals, encodeErrors,
			totalWriteBytes, fps, elapsed,
			sess.peer.ConnectionState(), sess.peer.ICEConnectionState())
	}

	for {
		select {
		case <-sess.peer.Done():
			logStats("peer-done")
			return
		case <-activityTimer.C:
			logStats("activity-timeout")
			log.Printf("[session %s] activity timeout (%v with no frames written), closing", sess.sessionID, activityTimeout)
			go sm.StopSession(sess.sessionID)
			return
		case <-statsTicker.C:
			logStats("periodic")
		case fps := <-sess.fpsCh:
			if fps != currentFPS {
				currentFPS = fps
				rateLimiter.Reset(time.Second / time.Duration(currentFPS))
				log.Printf("[session %s] fps_hint: adjusted to %d fps", sess.sessionID, currentFPS)
			}
		case <-rateLimiter.C:
			// Wait for a frame (or drain stale ones).
			var frame *device.Frame
			select {
			case f, ok := <-frames:
				if !ok {
					logStats("frames-closed")
					return
				}
				frame = f
				framesReceived++
			case <-sess.peer.Done():
				logStats("peer-done")
				return
			}

			// Drain any stale frames — always encode the freshest one.
			for {
				select {
				case newer, ok2 := <-frames:
					if !ok2 {
						logStats("frames-closed")
						return
					}
					framesDrained++
					frame = newer
				default:
					goto encode
				}
			}
		encode:

			y, cb, cr := encoder.ScaleAndConvertToI420(
				frame.Data,
				int(frame.Width), int(frame.Height),
				sess.targetW, sess.targetH,
			)

			nals, err := sess.enc.Encode(y, cb, cr)
			encoder.ReleaseI420(y) // return pooled buffer
			if err != nil {
				encodeErrors++
				log.Printf("[session %s] encode error: %v", sess.sessionID, err)
				continue
			}
			if nals == nil {
				nilNals++
				continue
			}
			framesEncoded++

			now := time.Now()
			duration := time.Second / 30
			if !lastTime.IsZero() {
				duration = now.Sub(lastTime)
			}
			lastTime = now

			if err := sess.peer.WriteVideoSample(nals, duration); err != nil {
				logStats("write-error")
				log.Printf("[session %s] write error: %v", sess.sessionID, err)
				return
			}
			framesWritten++
			totalWriteBytes += uint64(len(nals))

			// Reset activity timer on successful write.
			if !activityTimer.Stop() {
				select {
				case <-activityTimer.C:
				default:
				}
			}
			activityTimer.Reset(activityTimeout)
		}
	}
}

func (sm *SessionManager) runNALPipeline(sess *streamSession) {
	log.Printf("[session %s] NAL pipeline started", sess.sessionID)
	defer log.Printf("[session %s] NAL pipeline stopped", sess.sessionID)

	if sess.nalSource == nil {
		log.Printf("[session %s] NAL pipeline has no source", sess.sessionID)
		return
	}

	tuning := loadAdaptiveTuning()
	activityProbeInterval := tuning.nalInactivityProbe
	if activityProbeInterval <= 0 {
		activityProbeInterval = 15 * time.Second
	}
	activityCloseAfter := tuning.nalInactivityCloseAfter
	if activityCloseAfter < activityProbeInterval {
		activityCloseAfter = activityProbeInterval
	}

	activityTimer := time.NewTimer(activityProbeInterval)
	defer activityTimer.Stop()
	lastSampleAt := time.Now()

	refreshActivity := func() {
		if !activityTimer.Stop() {
			select {
			case <-activityTimer.C:
			default:
			}
		}
		lastSampleAt = time.Now()
		activityTimer.Reset(activityProbeInterval)
	}

	profiles := buildAdaptiveProfiles(sess.targetW, sess.targetH, sess.maxFPS)
	profileIndex := 0
	currentProfile := profiles[profileIndex]
	currentSource := sess.nalSource
	debugEnabled := envTruthy("YEP_BRIDGE_STREAM_DEBUG")

	// Progressive adaptation based on queue pressure and RTCP PLI feedback.
	baseBitrate := currentProfile.BitrateBps
	currentBitrate := currentProfile.BitrateBps
	minBitrate := tuning.minBitrate
	mildQueueDepth := tuning.mildQueueDepth
	moderateQueueDepth := tuning.moderateQueueDepth
	severeQueueDepth := tuning.severeQueueDepth
	severeWindow := tuning.severeWindow
	restartDownWindow := tuning.restartDownWindow
	recoveryWindow := tuning.recoveryWindow
	restartUpWindow := tuning.restartUpWindow
	restartCooldown := tuning.restartCooldown
	keyframeRequestBackoff := tuning.keyframeRequestBackoff
	bitrateChangeBackoff := tuning.bitrateChangeBackoff
	lastBitrateChangeAt := time.Time{}
	lastKeyframeReqAt := time.Time{}
	lastRestartAt := time.Time{}
	severeSince := time.Time{}
	recoverySince := time.Time{}
	profileStableSince := time.Time{}
	dropUntilKeyframe := false

	applyBitrate := func(target int, reason string) {
		if sess.streamCap == nil {
			return
		}
		if target == currentBitrate {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
		defer cancel()
		if err := sess.streamCap.SetStreamBitrate(ctx, target); err != nil {
			log.Printf("[session %s] stream_bitrate(%d) failed (%s): %v", sess.sessionID, target, reason, err)
			return
		}
		currentBitrate = target
		lastBitrateChangeAt = time.Now()
		log.Printf("[session %s] stream bitrate -> %d (%s)", sess.sessionID, target, reason)
	}

	requestKeyframe := func(reason string) {
		if sess.streamCap == nil {
			return
		}
		now := time.Now()
		if !lastKeyframeReqAt.IsZero() && now.Sub(lastKeyframeReqAt) < keyframeRequestBackoff {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
		defer cancel()
		if err := sess.streamCap.RequestStreamKeyframe(ctx); err != nil {
			log.Printf("[session %s] stream_keyframe failed (%s): %v", sess.sessionID, reason, err)
			return
		}
		lastKeyframeReqAt = now
		log.Printf("[session %s] requested keyframe (%s)", sess.sessionID, reason)
	}
	resetAdaptationState := func() {
		baseBitrate = currentProfile.BitrateBps
		currentBitrate = currentProfile.BitrateBps
		lastBitrateChangeAt = time.Time{}
		lastKeyframeReqAt = time.Time{}
		severeSince = time.Time{}
		recoverySince = time.Time{}
		profileStableSince = time.Time{}
		dropUntilKeyframe = false
	}

	var (
		lastPTSUs      int64
		seen           uint64
		seenConfig     uint64
		seenKeyframe   uint64
		written        uint64
		totalWriteByte uint64
		dropped        uint64
		statsStart     = time.Now()
		forcedDownDone bool
		forcedUpDone   bool
	)
	pliCh := sess.peer.PLI()
	var forceTick <-chan time.Time
	if tuning.forceProfileCycle {
		forceTicker := time.NewTicker(200 * time.Millisecond)
		defer forceTicker.Stop()
		forceTick = forceTicker.C
	}
	var debugTick <-chan time.Time
	var debugTicker *time.Ticker
	if debugEnabled {
		debugTicker = time.NewTicker(5 * time.Second)
		debugTick = debugTicker.C
		defer debugTicker.Stop()
	}

sourceLoop:
	for {
		id, nals := currentSource.Subscribe()
		if debugEnabled {
			log.Printf(
				"[session %s] NAL subscription attached (profile=%dx%d@%d, bitrate=%d)",
				sess.sessionID,
				currentProfile.Width,
				currentProfile.Height,
				currentProfile.FPS,
				currentBitrate,
			)
		}
		restartProfile := func(restartTo int, now time.Time) (bool, bool) {
			if restartTo < 0 || restartTo >= len(profiles) {
				return false, false
			}

			nextProfile := profiles[restartTo]
			direction := "downshift"
			if restartTo < profileIndex {
				direction = "upshift"
			}

			currentSource.Unsubscribe(id)
			newSource, err := sm.restartNALStream(sess, device.StreamOptions{
				Width:      nextProfile.Width,
				Height:     nextProfile.Height,
				FPS:        nextProfile.FPS,
				BitrateBps: nextProfile.BitrateBps,
			})
			if err != nil {
				log.Printf("[session %s] stream restart to %dx%d@%dfps failed: %v",
					sess.sessionID, nextProfile.Width, nextProfile.Height, nextProfile.FPS, err)
				return false, true
			}

			profileIndex = restartTo
			currentProfile = nextProfile
			currentSource = newSource
			lastRestartAt = now
			lastPTSUs = 0
			resetAdaptationState()
			log.Printf("[session %s] stream profile -> %dx%d@%dfps bitrate=%d (tier %d/%d)",
				sess.sessionID,
				currentProfile.Width, currentProfile.Height, currentProfile.FPS, currentProfile.BitrateBps,
				profileIndex+1, len(profiles))
			sm.sendProfileEvent(
				sess.sessionID,
				currentProfile,
				profileIndex+1,
				len(profiles),
				direction,
			)
			return true, false
		}

		for {
			select {
			case <-sess.peer.Done():
				currentSource.Unsubscribe(id)
				return
			case <-pliCh:
				requestKeyframe("pli")
				if !tuning.forceProfileCycle && tuning.dropUntilKeyframe {
					dropUntilKeyframe = true
				}
			case <-activityTimer.C:
				idleFor := time.Since(lastSampleAt)
				if idleFor < activityCloseAfter {
					log.Printf(
						"[session %s] NAL inactivity for %v (probe=%v, closeAfter=%v), requesting keyframe and continuing",
						sess.sessionID,
						idleFor.Truncate(time.Millisecond),
						activityProbeInterval,
						activityCloseAfter,
					)
					requestKeyframe("nal inactivity")
					activityTimer.Reset(activityProbeInterval)
					continue
				}
				currentSource.Unsubscribe(id)
				log.Printf(
					"[session %s] NAL activity timeout (%v with no samples, closeAfter=%v), closing",
					sess.sessionID,
					idleFor.Truncate(time.Millisecond),
					activityCloseAfter,
				)
				go sm.StopSession(sess.sessionID)
				return
			case <-debugTick:
				log.Printf(
					"[session %s] NAL debug: seen=%d written=%d dropped=%d config=%d key=%d q=%d idleFor=%v conn=%s ice=%s bitrate=%d profile=%dx%d@%d",
					sess.sessionID,
					seen,
					written,
					dropped,
					seenConfig,
					seenKeyframe,
					len(nals),
					time.Since(lastSampleAt).Truncate(time.Millisecond),
					sess.peer.ConnectionState(),
					sess.peer.ICEConnectionState(),
					currentBitrate,
					currentProfile.Width,
					currentProfile.Height,
					currentProfile.FPS,
				)
			case <-forceTick:
				now := time.Now()
				restartTo := -1
				elapsed := now.Sub(statsStart)
				if !forcedDownDone && elapsed >= tuning.forceDownAfter && profileIndex+1 < len(profiles) &&
					(lastRestartAt.IsZero() || now.Sub(lastRestartAt) >= restartCooldown) {
					restartTo = profileIndex + 1
					forcedDownDone = true
				} else if forcedDownDone && !forcedUpDone && elapsed >= tuning.forceUpAfter && profileIndex > 0 &&
					(lastRestartAt.IsZero() || now.Sub(lastRestartAt) >= restartCooldown) {
					restartTo = profileIndex - 1
					forcedUpDone = true
				}
				if restarted, fatal := restartProfile(restartTo, now); fatal {
					return
				} else if restarted {
					continue sourceLoop
				}
			case unit, ok := <-nals:
				if !ok {
					currentSource.Unsubscribe(id)
					return
				}
				if unit == nil {
					continue
				}
				refreshActivity()
				seen++
				if unit.Config {
					seenConfig++
				}
				if unit.Keyframe {
					seenKeyframe++
				}
				if debugEnabled && seen == 1 {
					log.Printf(
						"[session %s] first NAL observed: config=%v key=%v ptsUs=%d bytes=%d",
						sess.sessionID,
						unit.Config,
						unit.Keyframe,
						unit.PTSUs,
						len(unit.Data),
					)
				}

				now := time.Now()
				queueDepth := len(nals)
				restartTo := -1

				if !tuning.forceProfileCycle {
					if queueDepth >= severeQueueDepth {
						if severeSince.IsZero() {
							severeSince = now
						}
						if now.Sub(severeSince) >= severeWindow &&
							currentBitrate > minBitrate &&
							(lastBitrateChangeAt.IsZero() || now.Sub(lastBitrateChangeAt) >= bitrateChangeBackoff) {
							applyBitrate(minBitrate, "severe congestion")
							requestKeyframe("severe congestion")
							if tuning.dropUntilKeyframe {
								dropUntilKeyframe = true
							}
						}
						if now.Sub(severeSince) >= restartDownWindow &&
							currentBitrate <= minBitrate &&
							profileIndex+1 < len(profiles) &&
							(lastRestartAt.IsZero() || now.Sub(lastRestartAt) >= restartCooldown) {
							restartTo = profileIndex + 1
						}
					} else {
						severeSince = time.Time{}
					}

					if queueDepth >= moderateQueueDepth {
						requestKeyframe("moderate congestion")
						if tuning.dropUntilKeyframe {
							dropUntilKeyframe = true
						}
					}

					if queueDepth >= mildQueueDepth &&
						currentBitrate > minBitrate &&
						(lastBitrateChangeAt.IsZero() || now.Sub(lastBitrateChangeAt) >= bitrateChangeBackoff) {
						next := clampBitrateDown(currentBitrate, minBitrate)
						if next < currentBitrate {
							applyBitrate(next, "queue pressure")
						}
					}

					if queueDepth == 0 {
						if recoverySince.IsZero() {
							recoverySince = now
						}
						if now.Sub(recoverySince) >= recoveryWindow &&
							currentBitrate < baseBitrate &&
							(lastBitrateChangeAt.IsZero() || now.Sub(lastBitrateChangeAt) >= bitrateChangeBackoff) {
							next := clampBitrateUp(currentBitrate, baseBitrate)
							if next > currentBitrate {
								applyBitrate(next, "recovery")
							}
						}

						if currentBitrate >= baseBitrate && !dropUntilKeyframe {
							if profileStableSince.IsZero() {
								profileStableSince = now
							}
							if now.Sub(profileStableSince) >= restartUpWindow &&
								profileIndex > 0 &&
								(lastRestartAt.IsZero() || now.Sub(lastRestartAt) >= restartCooldown) {
								restartTo = profileIndex - 1
							}
						} else {
							profileStableSince = time.Time{}
						}
					} else {
						recoverySince = time.Time{}
						profileStableSince = time.Time{}
					}
				} else {
					recoverySince = time.Time{}
					profileStableSince = time.Time{}
				}

				if restarted, fatal := restartProfile(restartTo, now); fatal {
					return
				} else if restarted {
					continue sourceLoop
				}

				if dropUntilKeyframe && !unit.Config && !unit.Keyframe {
					dropped++
					continue
				}
				if unit.Keyframe {
					dropUntilKeyframe = false
				}
				if tuning.writeDelay > 0 && time.Since(statsStart) < tuning.writeDelayDuration {
					time.Sleep(tuning.writeDelay)
				}

				duration := time.Second / 30
				if lastPTSUs > 0 && unit.PTSUs > lastPTSUs {
					duration = time.Duration(unit.PTSUs-lastPTSUs) * time.Microsecond
					if duration <= 0 || duration > 2*time.Second {
						duration = time.Second / 30
					}
				}
				lastPTSUs = unit.PTSUs

				if err := sess.peer.WriteVideoSample(unit.Data, duration); err != nil {
					currentSource.Unsubscribe(id)
					log.Printf("[session %s] NAL write error: %v", sess.sessionID, err)
					return
				}
				written++
				totalWriteByte += uint64(len(unit.Data))

				if written%150 == 0 {
					elapsed := time.Since(statsStart).Seconds()
					fps := float64(0)
					if elapsed > 0 {
						fps = float64(written) / elapsed
					}
					log.Printf("[session %s] NAL stats: written=%d dropped=%d bytes=%d bitrate=%d fps=%.1f elapsed=%.1fs q=%d profile=%dx%d@%d",
						sess.sessionID, written, dropped, totalWriteByte, currentBitrate, fps, elapsed, len(nals),
						currentProfile.Width, currentProfile.Height, currentProfile.FPS)
				}
			}
		}
	}
}

type streamProfile struct {
	Width      int
	Height     int
	FPS        int
	BitrateBps int
}

func buildAdaptiveProfiles(targetW, targetH, maxFPS int) []streamProfile {
	if targetW <= 0 {
		targetW = 720
	}
	if targetH <= 0 {
		targetH = 1280
	}
	if maxFPS <= 0 {
		maxFPS = 30
	}

	type scale struct {
		pct int
	}
	scales := []scale{
		{pct: 100},
		{pct: 85},
		{pct: 70},
		{pct: 55},
	}

	out := make([]streamProfile, 0, len(scales))
	seen := make(map[string]struct{}, len(scales))
	for i, s := range scales {
		width := normalizeStreamDimension((targetW * s.pct) / 100)
		height := normalizeStreamDimension((targetH * s.pct) / 100)

		fps := maxFPS
		if i > 0 {
			fps = (maxFPS * s.pct) / 100
			if fps < 15 {
				fps = 15
			}
		}
		if fps > maxFPS {
			fps = maxFPS
		}
		if fps <= 0 {
			fps = 15
		}

		key := fmt.Sprintf("%dx%d@%d", width, height, fps)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}

		bitrate := estimateAndroidBitrate(width, height, fps)
		if bitrate < 500_000 {
			bitrate = 500_000
		}
		out = append(out, streamProfile{
			Width:      width,
			Height:     height,
			FPS:        fps,
			BitrateBps: bitrate,
		})
	}
	if len(out) == 0 {
		width := normalizeStreamDimension(targetW)
		height := normalizeStreamDimension(targetH)
		fps := maxFPS
		if fps <= 0 {
			fps = 30
		}
		out = append(out, streamProfile{
			Width:      width,
			Height:     height,
			FPS:        fps,
			BitrateBps: estimateAndroidBitrate(width, height, fps),
		})
	}
	return out
}

func normalizeStreamDimension(v int) int {
	if v < 64 {
		v = 64
	}
	if (v & 1) == 1 {
		v--
	}
	if v < 64 {
		return 64
	}
	return v
}

func loadAdaptiveTuning() adaptiveTuning {
	cfg := adaptiveTuning{
		minBitrate:              500_000,
		mildQueueDepth:          2,
		moderateQueueDepth:      5,
		severeQueueDepth:        8,
		severeWindow:            2 * time.Second,
		restartDownWindow:       4 * time.Second,
		recoveryWindow:          1 * time.Second,
		restartUpWindow:         12 * time.Second,
		restartCooldown:         10 * time.Second,
		keyframeRequestBackoff:  500 * time.Millisecond,
		bitrateChangeBackoff:    500 * time.Millisecond,
		nalInactivityProbe:      15 * time.Second,
		nalInactivityCloseAfter: 5 * time.Minute,
	}

	// Test-only mode for deterministic adaptive profile cycling in E2E.
	if envTruthy("YEP_BRIDGE_TEST_ADAPTIVE_PROFILE_CYCLE") {
		cfg.severeQueueDepth = 3
		cfg.severeWindow = 400 * time.Millisecond
		cfg.restartDownWindow = 1500 * time.Millisecond
		cfg.recoveryWindow = 300 * time.Millisecond
		cfg.restartUpWindow = 2500 * time.Millisecond
		cfg.restartCooldown = 1200 * time.Millisecond
		cfg.writeDelay = 140 * time.Millisecond
		cfg.writeDelayDuration = 3500 * time.Millisecond
		cfg.forceProfileCycle = true
		cfg.forceDownAfter = 2 * time.Second
		cfg.forceUpAfter = 6 * time.Second
	}

	// Optional overrides for targeted diagnostics.
	cfg.minBitrate = envInt("YEP_BRIDGE_ADAPTIVE_MIN_BITRATE", cfg.minBitrate)
	cfg.mildQueueDepth = envInt("YEP_BRIDGE_ADAPTIVE_MILD_QUEUE", cfg.mildQueueDepth)
	cfg.moderateQueueDepth = envInt("YEP_BRIDGE_ADAPTIVE_MODERATE_QUEUE", cfg.moderateQueueDepth)
	cfg.severeQueueDepth = envInt("YEP_BRIDGE_ADAPTIVE_SEVERE_QUEUE", cfg.severeQueueDepth)
	cfg.severeWindow = envDurationMS("YEP_BRIDGE_ADAPTIVE_SEVERE_WINDOW_MS", cfg.severeWindow)
	cfg.restartDownWindow = envDurationMS("YEP_BRIDGE_ADAPTIVE_RESTART_DOWN_WINDOW_MS", cfg.restartDownWindow)
	cfg.recoveryWindow = envDurationMS("YEP_BRIDGE_ADAPTIVE_RECOVERY_WINDOW_MS", cfg.recoveryWindow)
	cfg.restartUpWindow = envDurationMS("YEP_BRIDGE_ADAPTIVE_RESTART_UP_WINDOW_MS", cfg.restartUpWindow)
	cfg.restartCooldown = envDurationMS("YEP_BRIDGE_ADAPTIVE_RESTART_COOLDOWN_MS", cfg.restartCooldown)
	cfg.keyframeRequestBackoff = envDurationMS("YEP_BRIDGE_ADAPTIVE_KEYFRAME_BACKOFF_MS", cfg.keyframeRequestBackoff)
	cfg.bitrateChangeBackoff = envDurationMS("YEP_BRIDGE_ADAPTIVE_BITRATE_BACKOFF_MS", cfg.bitrateChangeBackoff)
	cfg.dropUntilKeyframe = envTruthy("YEP_BRIDGE_ADAPTIVE_DROP_UNTIL_KEYFRAME")
	cfg.writeDelay = envDurationMS("YEP_BRIDGE_TEST_NAL_WRITE_DELAY_MS", cfg.writeDelay)
	cfg.writeDelayDuration = envDurationMS("YEP_BRIDGE_TEST_NAL_WRITE_DELAY_DURATION_MS", cfg.writeDelayDuration)
	cfg.forceDownAfter = envDurationMS("YEP_BRIDGE_TEST_FORCE_DOWN_AFTER_MS", cfg.forceDownAfter)
	cfg.forceUpAfter = envDurationMS("YEP_BRIDGE_TEST_FORCE_UP_AFTER_MS", cfg.forceUpAfter)
	cfg.nalInactivityProbe = envDurationMS("YEP_BRIDGE_NAL_INACTIVITY_PROBE_MS", cfg.nalInactivityProbe)
	cfg.nalInactivityCloseAfter = envDurationMS("YEP_BRIDGE_NAL_INACTIVITY_CLOSE_AFTER_MS", cfg.nalInactivityCloseAfter)

	if cfg.mildQueueDepth < 0 {
		cfg.mildQueueDepth = 0
	}
	if cfg.moderateQueueDepth < cfg.mildQueueDepth {
		cfg.moderateQueueDepth = cfg.mildQueueDepth
	}
	if cfg.severeQueueDepth < cfg.moderateQueueDepth {
		cfg.severeQueueDepth = cfg.moderateQueueDepth
	}
	if cfg.minBitrate < 100_000 {
		cfg.minBitrate = 100_000
	}
	if cfg.nalInactivityProbe <= 0 {
		cfg.nalInactivityProbe = 15 * time.Second
	}
	if cfg.nalInactivityCloseAfter < cfg.nalInactivityProbe {
		cfg.nalInactivityCloseAfter = cfg.nalInactivityProbe
	}
	return cfg
}

func envInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return n
}

func envDurationMS(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if n <= 0 {
		return 0
	}
	return time.Duration(n) * time.Millisecond
}

func envTruthy(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func clampBitrateDown(current, min int) int {
	if current <= min {
		return min
	}
	next := (current * 3) / 4
	if next < min {
		return min
	}
	return next
}

func clampBitrateUp(current, max int) int {
	if current >= max {
		return max
	}
	next := (current * 5) / 4
	if next > max {
		return max
	}
	return next
}

func (sm *SessionManager) restartNALStream(sess *streamSession, opts device.StreamOptions) (*device.NalSource, error) {
	if sess.streamCap == nil {
		return nil, fmt.Errorf("stream restart requested without stream-capable device")
	}

	stopCtx, stopCancel := context.WithTimeout(context.Background(), 2*time.Second)
	if err := sess.streamCap.StopStream(stopCtx); err != nil {
		log.Printf("[session %s] stream_stop during restart failed: %v", sess.sessionID, err)
	}
	stopCancel()

	startCtx, startCancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer startCancel()
	source, err := sess.streamCap.StartStream(startCtx, opts)
	if err != nil {
		return nil, fmt.Errorf("stream_start during restart: %w", err)
	}

	sess.nalSource = source
	sess.targetW = opts.Width
	sess.targetH = opts.Height
	sess.maxFPS = opts.FPS
	return source, nil
}

func maybeStartAndroidStream(
	client device.Device,
	deviceType string,
	targetW int,
	targetH int,
	maxFPS int,
) (*device.NalSource, device.StreamCapable, error) {
	if !shouldUseMediaCodecStream(deviceType) {
		return nil, nil, nil
	}
	sc, ok := client.(device.StreamCapable)
	if !ok {
		return nil, nil, nil
	}
	streamOpts := device.StreamOptions{
		Width:      targetW,
		Height:     targetH,
		FPS:        maxFPS,
		BitrateBps: estimateAndroidBitrate(targetW, targetH, maxFPS),
	}
	if envTruthy("YEP_BRIDGE_STREAM_DEBUG") {
		log.Printf(
			"[stream probe] trying stream_start for %s at %dx%d@%dfps bitrate=%d",
			deviceType,
			streamOpts.Width,
			streamOpts.Height,
			streamOpts.FPS,
			streamOpts.BitrateBps,
		)
	}
	nalSource, err := sc.StartStream(context.Background(), streamOpts)
	if err != nil {
		return nil, nil, err
	}
	return nalSource, sc, nil
}

func shouldUseMediaCodecStream(deviceType string) bool {
	if strings.EqualFold(deviceType, "android") {
		return true
	}
	if strings.EqualFold(deviceType, "emulator") &&
		envTruthy("DEVICE_BRIDGE_USE_APK_FOR_EMULATOR") {
		return true
	}
	return false
}

func estimateAndroidBitrate(width, height, fps int) int {
	pixels := width * height
	switch {
	case pixels <= 640*360:
		return 800_000
	case pixels <= 960*540:
		return 1_200_000
	case pixels <= 1280*720:
		return 2_000_000
	default:
		if fps > 45 {
			return 4_000_000
		}
		return 3_000_000
	}
}

func (sm *SessionManager) sendProfileEvent(
	sessionID string,
	profile streamProfile,
	tier int,
	totalTiers int,
	direction string,
) {
	msg, _ := json.Marshal(map[string]interface{}{
		"type":       "stream.profile",
		"sessionId":  sessionID,
		"width":      profile.Width,
		"height":     profile.Height,
		"fps":        profile.FPS,
		"bitrate":    profile.BitrateBps,
		"tier":       tier,
		"totalTiers": totalTiers,
		"direction":  direction,
	})
	sm.sendMsg(msg)
}

// sendOffer sends a WebRTC offer to the Yep server.
func (sm *SessionManager) sendOffer(sessionID, sdp string) {
	msg, _ := json.Marshal(map[string]string{
		"type":      "webrtc.offer",
		"sessionId": sessionID,
		"sdp":       sdp,
	})
	sm.sendMsg(msg)
}

// sendICE sends an ICE candidate to the Yep server.
func (sm *SessionManager) sendICE(sessionID string, candidate *stream.ICECandidateJSON) {
	m := map[string]interface{}{
		"type":      "webrtc.ice",
		"sessionId": sessionID,
	}
	if candidate == nil {
		m["candidate"] = nil
	} else {
		m["candidate"] = candidate
	}
	msg, _ := json.Marshal(m)
	sm.sendMsg(msg)
}

// sendState sends a session state change to the Yep server.
func (sm *SessionManager) sendState(sessionID, state, errMsg string) {
	m := map[string]string{
		"type":      "session.state",
		"sessionId": sessionID,
		"state":     state,
	}
	if errMsg != "" {
		m["error"] = errMsg
	}
	msg, _ := json.Marshal(m)
	sm.sendMsg(msg)
}
