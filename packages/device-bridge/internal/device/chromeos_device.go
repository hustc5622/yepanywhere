package device

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image/jpeg"
	"io"
	"os/exec"
	"sync"

	"github.com/hustc5622/yepanywhere/device-bridge/internal/conn"
)

const (
	defaultChromeOSHost       = "chromeroot"
	defaultChromeOSDaemonPath = "/mnt/stateful_partition/c2/daemon.py"
)

// ChromeOSDevice communicates with daemon.py over an SSH subprocess's stdio.
type ChromeOSDevice struct {
	host string

	readCloser  io.ReadCloser
	writeCloser io.WriteCloser
	reader      io.Reader
	writer      io.Writer
	closeFn     func() error

	width  int32
	height int32

	writeMu   sync.Mutex
	closeOnce sync.Once
	closeErr  error
}

// NewChromeOSDevice starts an SSH subprocess and initializes the framed connection.
func NewChromeOSDevice(host string) (*ChromeOSDevice, error) {
	if host == "" {
		host = defaultChromeOSHost
	}

	cmd := exec.Command("ssh", host, "/usr/bin/python3", defaultChromeOSDaemonPath)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("ssh stdout pipe: %w", err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("ssh stdin pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("ssh start: %w", err)
	}

	closeFn := func() error {
		_ = stdin.Close()
		_ = stdout.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
		return nil
	}

	return NewChromeOSDeviceWithTransport(host, stdout, stdin, closeFn)
}

// NewChromeOSDeviceWithTransport creates a ChromeOSDevice from an existing transport.
// Intended for tests and dependency injection.
func NewChromeOSDeviceWithTransport(
	host string,
	reader io.ReadCloser,
	writer io.WriteCloser,
	closeFn func() error,
) (*ChromeOSDevice, error) {
	if host == "" {
		host = defaultChromeOSHost
	}
	if closeFn == nil {
		closeFn = func() error { return nil }
	}

	d := &ChromeOSDevice{
		host:        host,
		readCloser:  reader,
		writeCloser: writer,
		reader:      reader,
		writer:      writer,
		closeFn:     closeFn,
	}
	if err := d.readHandshake(); err != nil {
		_ = d.Close()
		return nil, err
	}
	return d, nil
}

func (d *ChromeOSDevice) readHandshake() error {
	var buf [4]byte
	if _, err := io.ReadFull(d.reader, buf[:]); err != nil {
		return fmt.Errorf("read handshake: %w", err)
	}
	d.width = int32(binary.LittleEndian.Uint16(buf[:2]))
	d.height = int32(binary.LittleEndian.Uint16(buf[2:4]))
	return nil
}

// GetFrame requests a frame and decodes the returned JPEG into RGB888.
func (d *ChromeOSDevice) GetFrame(ctx context.Context, maxWidth int) (*Frame, error) {
	_ = ctx
	_ = maxWidth

	d.writeMu.Lock()
	err := conn.WriteFrameRequest(d.writer)
	d.writeMu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("write frame request: %w", err)
	}

	msgType, payload, err := conn.ReadMessage(d.reader)
	if err != nil {
		return nil, fmt.Errorf("read frame response: %w", err)
	}
	if msgType != conn.TypeFrameResponse {
		return nil, fmt.Errorf("unexpected message type: 0x%02x", msgType)
	}

	rgb, width, height, err := decodeJPEGToRGB(payload)
	if err != nil {
		return nil, err
	}
	// Prefer decoded dimensions; handshake is only an initial hint.
	d.width = int32(width)
	d.height = int32(height)

	return &Frame{
		Data:   rgb,
		Width:  int32(width),
		Height: int32(height),
	}, nil
}

// SendTouch forwards touch control to daemon.py.
func (d *ChromeOSDevice) SendTouch(ctx context.Context, touches []TouchPoint) error {
	_ = ctx

	payload, err := json.Marshal(struct {
		Cmd     string       `json:"cmd"`
		Touches []TouchPoint `json:"touches"`
	}{
		Cmd:     "touch",
		Touches: touches,
	})
	if err != nil {
		return fmt.Errorf("marshal touch payload: %w", err)
	}
	return d.writeControl(payload)
}

// SendKey forwards key control to daemon.py.
func (d *ChromeOSDevice) SendKey(ctx context.Context, key string) error {
	_ = ctx

	payload, err := json.Marshal(struct {
		Cmd string `json:"cmd"`
		Key string `json:"key"`
	}{
		Cmd: "key",
		Key: key,
	})
	if err != nil {
		return fmt.Errorf("marshal key payload: %w", err)
	}
	return d.writeControl(payload)
}

func (d *ChromeOSDevice) writeControl(payload []byte) error {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	if err := conn.WriteControl(d.writer, payload); err != nil {
		return fmt.Errorf("write control: %w", err)
	}
	return nil
}

// ScreenSize returns the last known screen size.
func (d *ChromeOSDevice) ScreenSize() (width, height int32) {
	return d.width, d.height
}

// Close shuts down SSH transport and associated pipes.
func (d *ChromeOSDevice) Close() error {
	d.closeOnce.Do(func() {
		if d.writeCloser != nil {
			_ = d.writeCloser.Close()
		}
		if d.readCloser != nil {
			_ = d.readCloser.Close()
		}
		d.closeErr = d.closeFn()
	})
	return d.closeErr
}

func decodeJPEGToRGB(data []byte) ([]byte, int, int, error) {
	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("decode jpeg: %w", err)
	}

	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	rgb := make([]byte, width*height*3)

	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			r, g, b, _ := img.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
			i := (y*width + x) * 3
			rgb[i] = uint8(r >> 8)
			rgb[i+1] = uint8(g >> 8)
			rgb[i+2] = uint8(b >> 8)
		}
	}

	return rgb, width, height, nil
}
