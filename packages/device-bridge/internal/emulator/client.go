package emulator

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/hustc5622/yepanywhere/device-bridge/internal/device"
	pb "github.com/hustc5622/yepanywhere/device-bridge/proto/emulatorpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/emptypb"
)

// Client wraps the gRPC connection to a single emulator.
type Client struct {
	conn   *grpc.ClientConn
	client pb.EmulatorControllerClient
	ctx    context.Context // carries auth metadata
	token  string          // gRPC bearer token (for per-stream context creation)
	width  int32
	height int32
}

// NewClient discovers the gRPC token, connects, and probes screen dimensions.
func NewClient(addr string) (*Client, error) {
	token, err := findGRPCToken()
	if err != nil {
		return nil, fmt.Errorf("finding gRPC token: %w", err)
	}

	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(64*1024*1024)),
	)
	if err != nil {
		return nil, fmt.Errorf("connecting to emulator: %w", err)
	}

	c := &Client{
		conn:   conn,
		client: pb.NewEmulatorControllerClient(conn),
		ctx: metadata.AppendToOutgoingContext(context.Background(),
			"authorization", "Bearer "+token),
		token: token,
	}

	if err := c.probeScreenSize(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("probing screen size: %w", err)
	}

	return c, nil
}

// ScreenSize returns the native emulator resolution.
func (c *Client) ScreenSize() (width, height int32) {
	return c.width, c.height
}

// SendTouch forwards touch events to the emulator.
func (c *Client) SendTouch(ctx context.Context, touches []device.TouchPoint) error {
	pbTouches := make([]*pb.Touch, len(touches))
	for i, t := range touches {
		pbTouches[i] = &pb.Touch{
			X:          int32(t.X * float64(c.width)),
			Y:          int32(t.Y * float64(c.height)),
			Pressure:   int32(t.Pressure * 1024),
			Identifier: t.Identifier,
		}
	}
	_, err := c.client.SendTouch(c.ctx, &pb.TouchEvent{
		Touches: pbTouches,
	})
	return err
}

// GetFrame implements device.Device by returning one RGB888 screenshot.
func (c *Client) GetFrame(ctx context.Context, maxWidth int) (*device.Frame, error) {
	return c.GetOneScreenshot(ctx, maxWidth)
}

// SendKey sends a keyboard event to the emulator.
func (c *Client) SendKey(ctx context.Context, key string) error {
	_, err := c.client.SendKey(c.ctx, &pb.KeyboardEvent{
		EventType: pb.KeyboardEvent_keypress,
		Key:       key,
	})
	return err
}

// PollScreenshots polls getScreenshot in a loop and sends frames to the returned channel.
// This is much faster than StreamScreenshot which only emits on display changes (~0.1 fps).
// Polling getScreenshot achieves ~17 fps on the emulator's local gRPC.
// The channel is closed when the context is canceled or a gRPC error occurs.
func (c *Client) PollScreenshots(ctx context.Context, maxWidth int) <-chan *Frame {
	imgFmt := &pb.ImageFormat{
		Format: pb.ImageFormat_RGB888,
	}
	if maxWidth > 0 {
		imgFmt.Width = uint32(maxWidth)
	}

	ch := make(chan *Frame, 2)
	go func() {
		defer close(ch)
		var seq uint32
		for {
			if ctx.Err() != nil {
				return
			}

			img, err := c.client.GetScreenshot(c.ctx, imgFmt)
			if err != nil {
				return
			}

			seq++
			frame := &Frame{
				Data:   img.Image,
				Width:  int32(img.Format.Width),
				Height: int32(img.Format.Height),
				Seq:    seq,
			}

			select {
			case ch <- frame:
			case <-ctx.Done():
				return
			}
		}
	}()

	return ch
}

// GetOneScreenshot fetches a single screenshot from the emulator.
// Used by FrameSource for interruptible polling (checking subscriber count between frames).
func (c *Client) GetOneScreenshot(ctx context.Context, maxWidth int) (*Frame, error) {
	imgFmt := &pb.ImageFormat{
		Format: pb.ImageFormat_RGB888,
	}
	if maxWidth > 0 {
		imgFmt.Width = uint32(maxWidth)
	}

	// Use per-call context but carry auth metadata from c.ctx.
	md, _ := metadata.FromOutgoingContext(c.ctx)
	callCtx := metadata.NewOutgoingContext(ctx, md)

	img, err := c.client.GetScreenshot(callCtx, imgFmt)
	if err != nil {
		return nil, err
	}

	return &Frame{
		Data:   img.Image,
		Width:  int32(img.Format.Width),
		Height: int32(img.Format.Height),
	}, nil
}

// Close shuts down the gRPC connection.
func (c *Client) Close() error {
	return c.conn.Close()
}

func (c *Client) probeScreenSize() error {
	status, err := c.client.GetStatus(c.ctx, &emptypb.Empty{})
	if err != nil {
		return err
	}

	if status.HardwareConfig == nil {
		return fmt.Errorf("no hardware config in status")
	}

	for _, e := range status.HardwareConfig.Entry {
		switch e.Key {
		case "hw.lcd.width":
			fmt.Sscanf(e.Value, "%d", &c.width)
		case "hw.lcd.height":
			fmt.Sscanf(e.Value, "%d", &c.height)
		}
	}

	if c.width == 0 || c.height == 0 {
		return fmt.Errorf("could not determine screen dimensions")
	}

	return nil
}

// findGRPCToken reads the emulator discovery file to find the gRPC auth token.
func findGRPCToken() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot get home dir: %w", err)
	}

	// macOS: ~/Library/Caches/TemporaryItems/avd/running/pid_*.ini
	// Linux: /tmp/android-{user}/avd/running/pid_*.ini
	dirs := []string{
		filepath.Join(home, "Library", "Caches", "TemporaryItems", "avd", "running"),
		filepath.Join("/tmp", "android-"+filepath.Base(home), "avd", "running"),
	}

	for _, dir := range dirs {
		entries, err := filepath.Glob(filepath.Join(dir, "pid_*.ini"))
		if err != nil || len(entries) == 0 {
			continue
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
	}

	return "", fmt.Errorf("no gRPC token found in discovery files")
}
