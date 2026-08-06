package device

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/hustc5622/yepanywhere/device-bridge/internal/conn"
)

func TestChromeOSDeviceFramingWithMockTransport(t *testing.T) {
	deviceRead, sidecarWrite := io.Pipe()
	sidecarRead, deviceWrite := io.Pipe()

	done := make(chan error, 1)
	go func() {
		defer close(done)
		defer deviceWrite.Close()

		// Initial handshake: width=1, height=1.
		var handshake [4]byte
		binary.LittleEndian.PutUint16(handshake[:2], 1)
		binary.LittleEndian.PutUint16(handshake[2:], 1)
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

	d, err := NewChromeOSDeviceWithTransport("chromeroot", sidecarRead, sidecarWrite, func() error {
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

	if err := d.SendKey(context.Background(), "back"); err != nil {
		t.Fatalf("SendKey: %v", err)
	}
	if err := d.SendTouch(context.Background(), []TouchPoint{
		{X: 0.5, Y: 0.3, Pressure: 1.0},
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

func testJPEG(width, height int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	img.Set(0, 0, color.RGBA{R: 255, G: 10, B: 10, A: 255})

	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 100})
	return buf.Bytes()
}

type errString string

func (e errString) Error() string { return string(e) }

func errUnexpectedMessageType(msgType byte) error {
	return errString(fmt.Sprintf("unexpected message type: 0x%02x", msgType))
}
