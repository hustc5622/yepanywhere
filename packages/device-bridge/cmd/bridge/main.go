package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	bridgeDevice "github.com/hustc5622/yepanywhere/device-bridge/internal/device"
	"github.com/hustc5622/yepanywhere/device-bridge/internal/emulator"
	"github.com/hustc5622/yepanywhere/device-bridge/internal/encoder"
	"github.com/hustc5622/yepanywhere/device-bridge/internal/ipc"
	"github.com/hustc5622/yepanywhere/device-bridge/internal/stream"
)

//go:embed web
var webFS embed.FS

var bridgeVersion = "dev"

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address (standalone mode)")
	emuAddr := flag.String("emu", "localhost:8554", "Emulator gRPC address (standalone mode)")
	maxWidth := flag.Int("width", 360, "Max output width for video encoding")
	fps := flag.Int("fps", 30, "Target frame rate for encoder rate control")
	ipcMode := flag.Bool("ipc", false, "IPC mode: random port, stdout handshake, WebSocket protocol")
	adbPath := flag.String("adb-path", "adb", "Path to adb binary")
	flag.Parse()

	if *ipcMode {
		runIPC(*adbPath)
	} else {
		runStandalone(*addr, *emuAddr, *maxWidth, *fps)
	}
}

// runStandalone runs the original Phase 1 mode: single emulator, HTTP signaling, embedded test page.
func runStandalone(addr, emuAddr string, maxWidth, fps int) {
	log.Printf("Connecting to emulator at %s...", emuAddr)
	client, err := emulator.NewClient(emuAddr)
	if err != nil {
		log.Fatalf("Failed to connect to emulator: %v", err)
	}
	defer client.Close()

	srcW, srcH := client.ScreenSize()
	log.Printf("Emulator screen: %dx%d", srcW, srcH)

	targetW, targetH := encoder.ComputeTargetSize(int(srcW), int(srcH), maxWidth)
	log.Printf("Encoding resolution: %dx%d", targetW, targetH)

	h264Enc, err := encoder.NewH264Encoder(targetW, targetH, fps, 0)
	if err != nil {
		log.Fatalf("Failed to create encoder: %v", err)
	}
	defer h264Enc.Close()

	frameSource := bridgeDevice.NewFrameSource(client, maxWidth, fps)
	defer frameSource.Stop()

	inputHandler := stream.NewInputHandler(client)

	stunServers := []string{"stun:stun.l.google.com:19302"}
	sigHandler := stream.NewSignalingHandler(
		frameSource, h264Enc, inputHandler,
		stunServers, targetW, targetH,
	)

	mux := http.NewServeMux()

	webRoot, err := fs.Sub(webFS, "web")
	if err != nil {
		webRoot, _ = fs.Sub(webFS, ".")
	}
	mux.Handle("/", http.FileServer(http.FS(webRoot)))

	mux.HandleFunc("/api/connect", sigHandler.HandleConnect)
	mux.HandleFunc("/api/answer", sigHandler.HandleAnswer)
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ok":true,"screen":{"width":%d,"height":%d},"encoding":{"width":%d,"height":%d}}`,
			srcW, srcH, targetW, targetH)
	})

	server := &http.Server{
		Addr:        addr,
		Handler:     mux,
		ReadTimeout: 30 * time.Second,
		IdleTimeout: 120 * time.Second,
	}

	log.Printf("Listening on %s", addr)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("HTTP server error: %v", err)
	}
}

// monitorParent exits the process if the parent PID changes (parent died).
// This prevents orphaned sidecar processes when the server is killed.
func monitorParent() {
	parentPID := os.Getppid()
	go func() {
		for {
			time.Sleep(2 * time.Second)
			if os.Getppid() != parentPID {
				log.Printf("Parent process %d died, shutting down", parentPID)
				os.Exit(0)
			}
		}
	}()
}

// runIPC runs in IPC mode: picks a random port, prints handshake to stdout,
// serves REST endpoints and WebSocket for Yep server communication.
func runIPC(adbPath string) {
	monitorParent()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("Failed to listen: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port

	stunServers := []string{"stun:stun.l.google.com:19302"}
	handler := ipc.NewHandler(adbPath, stunServers, func() {
		log.Println("Idle timeout reached (no sessions for 10s), shutting down")
		os.Exit(0)
	})

	startedAt := time.Now()
	mux := http.NewServeMux()

	// Health endpoint.
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		uptime := int64(time.Since(startedAt).Seconds())
		fmt.Fprintf(w, `{"ok":true,"version":"%s","uptime":%d}`, bridgeVersion, uptime)
	})

	// Emulator discovery endpoints.
	mux.HandleFunc("/devices", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		devices, err := handler.GetDiscovery().ListDevices()
		if err != nil {
			http.Error(w, fmt.Sprintf("discovery error: %v", err), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(devices)
	})

	mux.HandleFunc("/devices/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/devices/")
		parts := strings.SplitN(path, "/", 2)
		if len(parts) != 2 {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		emulatorID := parts[0]
		action := parts[1]

		switch action {
		case "screenshot":
			handleScreenshot(w, r, emulatorID)
		case "start":
			handleEmulatorStart(w, r, emulatorID)
		case "stop":
			handleEmulatorStop(w, r, emulatorID)
		default:
			http.Error(w, "not found", http.StatusNotFound)
		}
	})

	// Shutdown endpoint.
	mux.HandleFunc("/shutdown", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
		go func() {
			time.Sleep(100 * time.Millisecond)
			log.Println("Shutdown requested, exiting...")
			os.Exit(0)
		}()
	})

	// WebSocket IPC endpoint.
	mux.HandleFunc("/ws", handler.ServeWS)

	// Print handshake to stdout (Yep server reads this).
	handshake, _ := json.Marshal(map[string]interface{}{
		"port":    port,
		"version": bridgeVersion,
	})
	fmt.Fprintln(os.Stdout, string(handshake))

	server := &http.Server{
		Handler:     mux,
		ReadTimeout: 30 * time.Second,
		IdleTimeout: 120 * time.Second,
	}

	log.Printf("IPC mode: listening on 127.0.0.1:%d", port)
	if err := server.Serve(listener); err != nil {
		log.Fatalf("HTTP server error: %v", err)
	}
}

func handleScreenshot(w http.ResponseWriter, r *http.Request, emulatorID string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	grpcAddr := ipc.GRPCAddr(emulatorID)
	client, err := emulator.NewClient(grpcAddr)
	if err != nil {
		http.Error(w, fmt.Sprintf("connect error: %v", err), http.StatusInternalServerError)
		return
	}
	defer client.Close()

	frameSource := bridgeDevice.NewFrameSource(client, 360, 0)
	defer frameSource.Stop()

	id, frames := frameSource.Subscribe()
	defer frameSource.Unsubscribe(id)

	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()

	select {
	case frame := <-frames:
		targetW, targetH := encoder.ComputeTargetSize(int(frame.Width), int(frame.Height), 360)
		scaled := encoder.Scale(frame.Data, int(frame.Width), int(frame.Height), targetW, targetH)
		jpegData := encoder.RGBToJPEG(scaled, targetW, targetH)
		w.Header().Set("Content-Type", "image/jpeg")
		w.Write(jpegData)
	case <-timer.C:
		http.Error(w, "timeout waiting for frame", http.StatusGatewayTimeout)
	case <-r.Context().Done():
		http.Error(w, "request canceled", http.StatusGatewayTimeout)
	}
}

func handleEmulatorStart(w http.ResponseWriter, r *http.Request, emulatorID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	avdName := strings.TrimPrefix(emulatorID, "avd-")
	if avdName == emulatorID {
		http.Error(w, "emulator already running", http.StatusConflict)
		return
	}

	go func() {
		cmd := exec.Command("emulator", "-avd", avdName, "-no-window")
		if err := cmd.Start(); err != nil {
			log.Printf("failed to start emulator %s: %v", avdName, err)
		}
	}()

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

func handleEmulatorStop(w http.ResponseWriter, r *http.Request, emulatorID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cmd := exec.Command("adb", "-s", emulatorID, "emu", "kill")
	if err := cmd.Run(); err != nil {
		log.Printf("failed to stop emulator %s: %v", emulatorID, err)
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}
