package main

import (
	"context"
	"fmt"
	"image"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	pb "github.com/hustc5622/yepanywhere/device-bridge/proto/emulatorpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/emptypb"
)

const (
	defaultAddr = "localhost:8554"
)

func main() {
	addr := defaultAddr
	if len(os.Args) > 1 {
		addr = os.Args[1]
	}

	token, err := findGRPCToken()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error finding gRPC token: %v\n", err)
		fmt.Fprintf(os.Stderr, "Is an Android emulator running?\n")
		os.Exit(1)
	}
	fmt.Printf("Found gRPC token: %s...%s\n", token[:8], token[len(token)-4:])

	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(64*1024*1024)),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to connect: %v\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	client := pb.NewEmulatorControllerClient(conn)
	ctx := metadata.AppendToOutgoingContext(context.Background(),
		"authorization", "Bearer "+token)

	// 1. Get status
	fmt.Println("\n=== 1. getStatus ===")
	testGetStatus(ctx, client)

	// 2. Get screenshot (PNG)
	fmt.Println("\n=== 2. getScreenshot (PNG) ===")
	testGetScreenshot(ctx, client, pb.ImageFormat_PNG, 0)

	// 3. Get screenshot (RGB888, full res)
	fmt.Println("\n=== 3. getScreenshot (RGB888, full res) ===")
	testGetScreenshot(ctx, client, pb.ImageFormat_RGB888, 0)

	// 4. Get screenshot (RGB888, 720px wide)
	fmt.Println("\n=== 4. getScreenshot (RGB888, 720w) ===")
	testGetScreenshot(ctx, client, pb.ImageFormat_RGB888, 720)

	// 5. Get screenshot (RGB888, 480px wide)
	fmt.Println("\n=== 5. getScreenshot (RGB888, 480w) ===")
	testGetScreenshot(ctx, client, pb.ImageFormat_RGB888, 480)

	// 6. Stream screenshots (with touch to generate frame updates)
	fmt.Println("\n=== 6. streamScreenshot (RGB888, 5 seconds, with touch activity) ===")
	testStreamScreenshot(ctx, client)

	// 7. Test touch input
	fmt.Println("\n=== 7. sendTouch ===")
	testSendTouch(ctx, client)

	// 8. Test key input
	fmt.Println("\n=== 8. sendKey (Home) ===")
	testSendKey(ctx, client)

	fmt.Println("\n=== Validation complete ===")
}

// findGRPCToken reads the emulator discovery file to find the gRPC auth token.
func findGRPCToken() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot get home dir: %w", err)
	}

	// Discovery files are at ~/Library/Caches/TemporaryItems/avd/running/pid_*.ini (macOS)
	discoveryDir := filepath.Join(home, "Library", "Caches", "TemporaryItems", "avd", "running")
	entries, err := filepath.Glob(filepath.Join(discoveryDir, "pid_*.ini"))
	if err != nil {
		return "", fmt.Errorf("glob discovery files: %w", err)
	}
	if len(entries) == 0 {
		return "", fmt.Errorf("no discovery files found in %s", discoveryDir)
	}

	for _, entry := range entries {
		data, err := os.ReadFile(entry)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "grpc.token=") {
				return strings.TrimPrefix(line, "grpc.token="), nil
			}
		}
	}
	return "", fmt.Errorf("no grpc.token found in discovery files")
}

func testGetStatus(ctx context.Context, client pb.EmulatorControllerClient) {
	status, err := client.GetStatus(ctx, &emptypb.Empty{})
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ERROR: %v\n", err)
		return
	}
	fmt.Printf("  Version: %s\n", status.Version)
	fmt.Printf("  Booted: %v\n", status.Booted)
	fmt.Printf("  Uptime: %d ms\n", status.Uptime)
	if status.VmConfig != nil {
		fmt.Printf("  CPU cores: %d, RAM: %d MB\n",
			status.VmConfig.NumberOfCpuCores,
			status.VmConfig.RamSizeBytes/1024/1024)
	}

	// Extract screen dimensions from hardware config
	if status.HardwareConfig != nil {
		var width, height, density string
		for _, e := range status.HardwareConfig.Entry {
			switch e.Key {
			case "hw.lcd.width":
				width = e.Value
			case "hw.lcd.height":
				height = e.Value
			case "hw.lcd.density":
				density = e.Value
			}
		}
		fmt.Printf("  Screen: %sx%s @ %s dpi\n", width, height, density)
	}
}

func testGetScreenshot(ctx context.Context, client pb.EmulatorControllerClient, format pb.ImageFormat_ImgFormat, width uint32) {
	req := &pb.ImageFormat{Format: format}
	if width > 0 {
		req.Width = width
	}
	start := time.Now()
	img, err := client.GetScreenshot(ctx, req)
	elapsed := time.Since(start)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ERROR: %v\n", err)
		return
	}

	fmt.Printf("  Format: %v\n", img.Format.Format)
	fmt.Printf("  Dimensions: %dx%d\n", img.Format.Width, img.Format.Height)
	fmt.Printf("  Data size: %d bytes (%.2f MB)\n", len(img.Image), float64(len(img.Image))/1024/1024)
	fmt.Printf("  Latency: %v\n", elapsed)

	if format == pb.ImageFormat_PNG && len(img.Image) > 0 {
		outPath := "/tmp/emu-validate-screenshot.png"
		if err := os.WriteFile(outPath, img.Image, 0644); err == nil {
			fmt.Printf("  Saved: %s\n", outPath)
		}
	}

	if format == pb.ImageFormat_RGB888 && len(img.Image) > 0 {
		// Verify the data size matches expected dimensions
		expected := int(img.Format.Width) * int(img.Format.Height) * 3
		fmt.Printf("  Expected: %d bytes, Match: %v\n", expected, len(img.Image) == expected)

		// Save as PNG for visual verification
		w := int(img.Format.Width)
		h := int(img.Format.Height)
		rgba := image.NewRGBA(image.Rect(0, 0, w, h))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				srcIdx := (y*w + x) * 3
				dstIdx := (y*w + x) * 4
				rgba.Pix[dstIdx+0] = img.Image[srcIdx+0] // R
				rgba.Pix[dstIdx+1] = img.Image[srcIdx+1] // G
				rgba.Pix[dstIdx+2] = img.Image[srcIdx+2] // B
				rgba.Pix[dstIdx+3] = 255                  // A
			}
		}
		outPath := "/tmp/emu-validate-rgb888.png"
		f, err := os.Create(outPath)
		if err == nil {
			defer f.Close()
			png.Encode(f, rgba)
			fmt.Printf("  Saved as PNG: %s\n", outPath)
		}
	}
}

func testStreamScreenshot(ctx context.Context, client pb.EmulatorControllerClient) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	stream, err := client.StreamScreenshot(ctx, &pb.ImageFormat{
		Format: pb.ImageFormat_RGB888,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ERROR starting stream: %v\n", err)
		return
	}

	// Generate touch activity in a goroutine to produce frame updates
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			// Swipe down to generate screen updates
			for y := int32(800); y < 1600; y += 50 {
				client.SendTouch(ctx, &pb.TouchEvent{
					Touches: []*pb.Touch{
						{X: 540, Y: y, Pressure: 1024, Identifier: 0},
					},
				})
				time.Sleep(16 * time.Millisecond)
			}
			// Release
			client.SendTouch(ctx, &pb.TouchEvent{
				Touches: []*pb.Touch{
					{X: 540, Y: 1600, Pressure: 0, Identifier: 0},
				},
			})
			time.Sleep(200 * time.Millisecond)
		}
	}()

	var (
		frameCount   int
		totalBytes   int64
		firstFrame   time.Time
		lastFrame    time.Time
		minFrameSize int
		maxFrameSize int
		frameTimes   []time.Duration
		prevTime     time.Time
	)

	for {
		img, err := stream.Recv()
		if err != nil {
			if err == io.EOF || ctx.Err() != nil {
				break
			}
			fmt.Fprintf(os.Stderr, "  ERROR receiving: %v\n", err)
			break
		}

		now := time.Now()
		frameSize := len(img.Image)

		if frameCount == 0 {
			firstFrame = now
			minFrameSize = frameSize
			maxFrameSize = frameSize
			fmt.Printf("  First frame: %dx%d, %d bytes (%.2f MB)\n",
				img.Format.Width, img.Format.Height,
				frameSize, float64(frameSize)/1024/1024)
		} else {
			interval := now.Sub(prevTime)
			frameTimes = append(frameTimes, interval)
			if frameSize < minFrameSize {
				minFrameSize = frameSize
			}
			if frameSize > maxFrameSize {
				maxFrameSize = frameSize
			}
		}

		totalBytes += int64(frameSize)
		frameCount++
		lastFrame = now
		prevTime = now
	}

	if frameCount > 0 {
		duration := lastFrame.Sub(firstFrame)
		fps := float64(frameCount-1) / duration.Seconds()

		fmt.Printf("  Frames received: %d\n", frameCount)
		fmt.Printf("  Duration: %v\n", duration)
		fmt.Printf("  FPS: %.1f\n", fps)
		fmt.Printf("  Total data: %.2f MB\n", float64(totalBytes)/1024/1024)
		fmt.Printf("  Data rate: %.1f MB/s\n", float64(totalBytes)/1024/1024/duration.Seconds())
		fmt.Printf("  Frame size range: %d - %d bytes\n", minFrameSize, maxFrameSize)

		if len(frameTimes) > 0 {
			var totalInterval time.Duration
			var minInterval, maxInterval time.Duration
			minInterval = frameTimes[0]
			maxInterval = frameTimes[0]
			for _, ft := range frameTimes {
				totalInterval += ft
				if ft < minInterval {
					minInterval = ft
				}
				if ft > maxInterval {
					maxInterval = ft
				}
			}
			avgInterval := totalInterval / time.Duration(len(frameTimes))
			fmt.Printf("  Frame interval: avg=%v min=%v max=%v\n",
				avgInterval, minInterval, maxInterval)
		}
	} else {
		fmt.Println("  No frames received!")
	}
}

func testSendTouch(ctx context.Context, client pb.EmulatorControllerClient) {
	// Tap at center of a 1080x2400 screen
	x, y := int32(540), int32(1200)

	// Touch down
	_, err := client.SendTouch(ctx, &pb.TouchEvent{
		Touches: []*pb.Touch{
			{X: x, Y: y, Pressure: 1024, Identifier: 0},
		},
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ERROR (down): %v\n", err)
		return
	}
	fmt.Printf("  Touch down at (%d, %d)\n", x, y)

	time.Sleep(100 * time.Millisecond)

	// Touch up
	_, err = client.SendTouch(ctx, &pb.TouchEvent{
		Touches: []*pb.Touch{
			{X: x, Y: y, Pressure: 0, Identifier: 0},
		},
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ERROR (up): %v\n", err)
		return
	}
	fmt.Printf("  Touch up at (%d, %d)\n", x, y)
	fmt.Println("  Touch input OK")
}

func testSendKey(ctx context.Context, client pb.EmulatorControllerClient) {
	_, err := client.SendKey(ctx, &pb.KeyboardEvent{
		EventType: pb.KeyboardEvent_keypress,
		Key:       "Home",
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ERROR: %v\n", err)
		return
	}
	fmt.Println("  Home key sent OK")
}
