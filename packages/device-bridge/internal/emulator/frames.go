package emulator

import "github.com/hustc5622/yepanywhere/device-bridge/internal/device"

// Frame aliases the shared device frame type.
type Frame = device.Frame

// FrameSource aliases the shared device frame source implementation.
type FrameSource = device.FrameSource

// NewFrameSource is retained for standalone compatibility.
var NewFrameSource = device.NewFrameSource
