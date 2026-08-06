package device

import (
	"context"
	"encoding/binary"
	"io"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/hustc5622/yepanywhere/device-bridge/internal/conn"
)

func TestIOSSimulatorDeviceFramingWithMockTransport(t *testing.T) {
	deviceRead, sidecarWrite := io.Pipe()
	sidecarRead, deviceWrite := io.Pipe()

	done := make(chan error, 1)
	go func() {
		defer close(done)
		defer deviceWrite.Close()

		var handshake [4]byte
		binary.LittleEndian.PutUint16(handshake[:2], 1)
		binary.LittleEndian.PutUint16(handshake[2:4], 1)
		if _, err := deviceWrite.Write(handshake[:]); err != nil {
			done <- err
			return
		}

		controlPayloads := make([]string, 0, 2)
		for len(controlPayloads) < 2 {
			msgType, payload, err := conn.ReadMessage(deviceRead)
			if err != nil {
				done <- err
				return
			}

			switch msgType {
			case conn.TypeFrameRequest:
				if err := conn.WriteFrameResponse(deviceWrite, testJPEG(1, 1)); err != nil {
					done <- err
					return
				}
			case conn.TypeControl:
				controlPayloads = append(controlPayloads, string(payload))
			default:
				done <- errUnexpectedMessageType(msgType)
				return
			}
		}

		if !strings.Contains(controlPayloads[0], `"cmd":"key"`) &&
			!strings.Contains(controlPayloads[1], `"cmd":"key"`) {
			done <- errString("missing key control payload")
			return
		}
		if !strings.Contains(controlPayloads[0], `"cmd":"touch"`) &&
			!strings.Contains(controlPayloads[1], `"cmd":"touch"`) {
			done <- errString("missing touch control payload")
			return
		}

		done <- nil
	}()

	d, err := NewIOSSimulatorDeviceWithTransport("sim-udid", sidecarRead, sidecarWrite, func() error {
		_ = sidecarWrite.Close()
		_ = sidecarRead.Close()
		return nil
	})
	if err != nil {
		t.Fatalf("new device: %v", err)
	}
	defer d.Close()

	w, h := d.ScreenSize()
	if w != 1 || h != 1 {
		t.Fatalf("unexpected handshake dimensions: %dx%d", w, h)
	}

	frame, err := d.GetFrame(context.Background(), 0)
	if err != nil {
		t.Fatalf("GetFrame: %v", err)
	}
	if frame.Width != 1 || frame.Height != 1 {
		t.Fatalf("unexpected frame dimensions: %dx%d", frame.Width, frame.Height)
	}
	if len(frame.Data) != 3 {
		t.Fatalf("expected RGB frame length 3, got %d", len(frame.Data))
	}

	if err := d.SendKey(context.Background(), "home"); err != nil {
		t.Fatalf("SendKey: %v", err)
	}
	if err := d.SendTouch(context.Background(), []TouchPoint{
		{X: 0.5, Y: 0.5, Pressure: 1.0},
	}); err != nil {
		t.Fatalf("SendTouch: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("mock device goroutine: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for mock device goroutine")
	}
}

func TestIOSSimulatorSourceCandidatesIncludeRepoPaths(t *testing.T) {
	exePath := "/Users/test/code/yepanywhere/packages/device-bridge/bridge"
	cwd := "/Users/test/code/yepanywhere/packages/server"

	candidates := iosSimServerSourceCandidates(exePath, cwd)
	want := filepath.Clean("/Users/test/code/yepanywhere/packages/ios-sim-server")
	if !slices.Contains(candidates, want) {
		t.Fatalf("expected %q in candidates: %v", want, candidates)
	}
}

func TestIOSSimulatorBinaryCandidatesIncludeBuiltArtifactPath(t *testing.T) {
	exePath := "/Users/test/code/yepanywhere/packages/device-bridge/bridge"
	cwd := "/Users/test/code/yepanywhere/packages/server"

	candidates := iosSimServerBinaryCandidates("/tmp/yep-anywhere", exePath, cwd, "/Users/test")
	sourceCandidates := iosSimServerSourceCandidates(exePath, cwd)

	wantBuilt := filepath.Clean("/Users/test/code/yepanywhere/packages/ios-sim-server/.build/release/ios-sim-server")
	foundBuilt := false
	for _, sourceDir := range sourceCandidates {
		if filepath.Join(sourceDir, ".build", "release", defaultIOSSimServerName) == wantBuilt {
			foundBuilt = true
			break
		}
	}
	if !foundBuilt {
		t.Fatalf("expected built artifact candidate derived from source dir %q", wantBuilt)
	}

	wantDataDir := filepath.Clean("/tmp/yep-anywhere/bin/ios-sim-server")
	if !slices.Contains(candidates, wantDataDir) {
		t.Fatalf("expected %q in binary candidates: %v", wantDataDir, candidates)
	}
}

func TestSimctlReportsBootedUDID(t *testing.T) {
	data := []byte(`{
  "devices": {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
      {"udid":"BOOTED-1","name":"iPhone 17","state":"Booted"},
      {"udid":"SHUTDOWN-1","name":"iPhone 16","state":"Shutdown"}
    ]
  }
}`)

	booted, err := simctlReportsBootedUDID(data, "BOOTED-1")
	if err != nil {
		t.Fatalf("simctlReportsBootedUDID returned error: %v", err)
	}
	if !booted {
		t.Fatal("expected BOOTED-1 to be reported as booted")
	}

	booted, err = simctlReportsBootedUDID(data, "SHUTDOWN-1")
	if err != nil {
		t.Fatalf("simctlReportsBootedUDID returned error: %v", err)
	}
	if booted {
		t.Fatal("expected SHUTDOWN-1 to be reported as not booted")
	}

	booted, err = simctlReportsBootedUDID(data, "MISSING-1")
	if err != nil {
		t.Fatalf("simctlReportsBootedUDID returned error: %v", err)
	}
	if booted {
		t.Fatal("expected missing UDID to be reported as not booted")
	}
}

func TestSimctlReportsBootedUDIDRejectsInvalidJSON(t *testing.T) {
	if _, err := simctlReportsBootedUDID([]byte("{"), "BOOTED-1"); err == nil {
		t.Fatal("expected invalid json to fail")
	}
}
