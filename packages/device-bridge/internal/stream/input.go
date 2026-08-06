package stream

import (
	"context"
	"encoding/json"
	"log"

	"github.com/hustc5622/yepanywhere/device-bridge/internal/device"
)

// InputHandler translates browser touch/key events to device control calls.
type InputHandler struct {
	client device.Device
}

// NewInputHandler creates a handler that maps normalized coordinates to device resolution.
func NewInputHandler(client device.Device) *InputHandler {
	return &InputHandler{client: client}
}

type inputMessage struct {
	Type    string       `json:"type"`
	Touches []inputTouch `json:"touches,omitempty"`
	Key     string       `json:"key,omitempty"`
}

type inputTouch struct {
	ID       int32   `json:"id"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Pressure float64 `json:"pressure"`
}

// HandleMessage processes a DataChannel message (JSON).
func (ih *InputHandler) HandleMessage(msg []byte) {
	var m inputMessage
	if err := json.Unmarshal(msg, &m); err != nil {
		log.Printf("input: bad message: %v", err)
		return
	}

	ctx := context.Background()

	switch m.Type {
	case "touch":
		touches := make([]device.TouchPoint, len(m.Touches))
		for i, t := range m.Touches {
			touches[i] = device.TouchPoint{
				X:          t.X,
				Y:          t.Y,
				Pressure:   t.Pressure,
				Identifier: t.ID,
			}
		}
		if err := ih.client.SendTouch(ctx, touches); err != nil {
			log.Printf("input: touch error: %v", err)
		}

	case "key":
		if m.Key == "" {
			return
		}
		if err := ih.client.SendKey(ctx, m.Key); err != nil {
			log.Printf("input: key error: %v", err)
		}

	default:
		log.Printf("input: unknown message type: %s", m.Type)
	}
}
