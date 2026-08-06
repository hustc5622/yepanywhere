package ipc

import (
	"fmt"
	"log"
	"os"
	"strings"
	"sync"

	"github.com/hustc5622/yepanywhere/device-bridge/internal/device"
	"github.com/hustc5622/yepanywhere/device-bridge/internal/emulator"
)

const useAPKForEmulatorEnvVar = "DEVICE_BRIDGE_USE_APK_FOR_EMULATOR"

// clientEntry is a ref-counted device connection.
type clientEntry struct {
	client   device.Device
	refCount int
}

// frameSourceEntry is a ref-counted FrameSource.
type frameSourceEntry struct {
	source   *device.FrameSource
	refCount int
}

// frameSourceKey uniquely identifies a FrameSource by device + resolution.
type frameSourceKey struct {
	deviceID string
	maxWidth int
}

// ResourcePool manages shared Device connections and FrameSources across sessions.
// Multiple sessions viewing the same device at the same resolution share
// a single device connection and polling loop.
type ResourcePool struct {
	mu           sync.Mutex
	adbPath      string
	clients      map[string]*clientEntry
	frameSources map[frameSourceKey]*frameSourceEntry
}

// NewResourcePool creates an empty resource pool.
func NewResourcePool(adbPath string) *ResourcePool {
	if strings.TrimSpace(adbPath) == "" {
		adbPath = "adb"
	}
	return &ResourcePool{
		adbPath:      adbPath,
		clients:      make(map[string]*clientEntry),
		frameSources: make(map[frameSourceKey]*frameSourceEntry),
	}
}

// AcquireDevice returns a shared device connection, creating one if needed.
func (rp *ResourcePool) AcquireDevice(deviceID, deviceType string) (device.Device, error) {
	rp.mu.Lock()
	defer rp.mu.Unlock()

	if entry, ok := rp.clients[deviceID]; ok {
		entry.refCount++
		log.Printf("[ResourcePool] reusing device for %s (refs=%d)", deviceID, entry.refCount)
		return entry.client, nil
	}

	client, err := rp.createDeviceLocked(deviceID, deviceType)
	if err != nil {
		return nil, err
	}

	rp.clients[deviceID] = &clientEntry{client: client, refCount: 1}
	log.Printf("[ResourcePool] created new device connection for %s", deviceID)
	return client, nil
}

func (rp *ResourcePool) createDeviceLocked(deviceID, deviceType string) (device.Device, error) {
	switch strings.ToLower(strings.TrimSpace(deviceType)) {
	case "chromeos":
		host := os.Getenv("CHROMEOS_HOST")
		if strings.HasPrefix(deviceID, "chromeos:") {
			host = strings.TrimPrefix(deviceID, "chromeos:")
		}
		d, err := device.NewChromeOSDevice(host)
		if err != nil {
			return nil, fmt.Errorf("connecting to chromeos device %s: %w", deviceID, err)
		}
		return d, nil
	case "android":
		if serial, ok := androidSerialForDevice(deviceID, "android"); ok {
			d, err := device.NewAndroidDevice(serial, rp.adbPath)
			if err != nil {
				return nil, fmt.Errorf("connecting to android device %s (id=%s): %w", serial, deviceID, err)
			}
			return d, nil
		}
		return nil, fmt.Errorf("invalid android device id: %s", deviceID)
	case "emulator":
		if serial, ok := androidSerialForDevice(deviceID, "emulator"); ok {
			d, err := device.NewAndroidDevice(serial, rp.adbPath)
			if err != nil {
				return nil, fmt.Errorf("connecting to emulator via android transport %s (id=%s): %w", serial, deviceID, err)
			}
			return d, nil
		}
		if strings.HasPrefix(deviceID, "emulator-") {
			grpcAddr := GRPCAddr(deviceID)
			d, err := emulator.NewClient(grpcAddr)
			if err != nil {
				return nil, fmt.Errorf("connecting to emulator %s: %w", deviceID, err)
			}
			return d, nil
		}
		if strings.HasPrefix(deviceID, "avd-") {
			return nil, fmt.Errorf("device %s is not running", deviceID)
		}
		return nil, fmt.Errorf("invalid emulator device id: %s", deviceID)
	case "ios-simulator":
		d, err := device.NewIOSSimulatorDevice(deviceID)
		if err != nil {
			return nil, fmt.Errorf("connecting to ios simulator %s: %w", deviceID, err)
		}
		return d, nil
	}

	if deviceID == "chromeos" || strings.HasPrefix(deviceID, "chromeos:") {
		host := os.Getenv("CHROMEOS_HOST")
		if strings.HasPrefix(deviceID, "chromeos:") {
			host = strings.TrimPrefix(deviceID, "chromeos:")
		}
		d, err := device.NewChromeOSDevice(host)
		if err != nil {
			return nil, fmt.Errorf("connecting to chromeos device %s: %w", deviceID, err)
		}
		return d, nil
	}

	if serial, ok := androidSerialForDevice(deviceID, ""); ok {
		d, err := device.NewAndroidDevice(serial, rp.adbPath)
		if err != nil {
			return nil, fmt.Errorf("connecting to android device %s (id=%s): %w", serial, deviceID, err)
		}
		return d, nil
	}

	if strings.HasPrefix(deviceID, "emulator-") {
		grpcAddr := GRPCAddr(deviceID)
		d, err := emulator.NewClient(grpcAddr)
		if err != nil {
			return nil, fmt.Errorf("connecting to emulator %s: %w", deviceID, err)
		}
		return d, nil
	}

	if strings.HasPrefix(deviceID, "avd-") {
		return nil, fmt.Errorf("device %s is not running", deviceID)
	}
	return nil, fmt.Errorf("unknown device id: %s", deviceID)
}

// ReleaseDevice decrements the ref count and closes the device when it reaches 0.
func (rp *ResourcePool) ReleaseDevice(deviceID string) {
	rp.mu.Lock()
	defer rp.mu.Unlock()

	entry, ok := rp.clients[deviceID]
	if !ok {
		return
	}

	entry.refCount--
	if entry.refCount <= 0 {
		entry.client.Close()
		delete(rp.clients, deviceID)
		log.Printf("[ResourcePool] closed device connection for %s", deviceID)
	}
}

// AcquireFrameSource returns a shared FrameSource, creating one if needed.
// The device must already be acquired via AcquireDevice.
func (rp *ResourcePool) AcquireFrameSource(deviceID string, maxWidth, fps int, d device.Device) *device.FrameSource {
	rp.mu.Lock()
	defer rp.mu.Unlock()

	key := frameSourceKey{deviceID: deviceID, maxWidth: maxWidth}
	if entry, ok := rp.frameSources[key]; ok {
		entry.refCount++
		log.Printf("[ResourcePool] reusing FrameSource for %s@%d (refs=%d)", deviceID, maxWidth, entry.refCount)
		return entry.source
	}

	fs := device.NewFrameSource(d, maxWidth, fps)
	rp.frameSources[key] = &frameSourceEntry{source: fs, refCount: 1}
	log.Printf("[ResourcePool] created new FrameSource for %s@%d fps=%d", deviceID, maxWidth, fps)
	return fs
}

// ReleaseFrameSource decrements the ref count and stops the FrameSource when it reaches 0.
func (rp *ResourcePool) ReleaseFrameSource(deviceID string, maxWidth int) {
	rp.mu.Lock()
	defer rp.mu.Unlock()

	key := frameSourceKey{deviceID: deviceID, maxWidth: maxWidth}
	entry, ok := rp.frameSources[key]
	if !ok {
		return
	}

	entry.refCount--
	if entry.refCount <= 0 {
		entry.source.Stop()
		delete(rp.frameSources, key)
		log.Printf("[ResourcePool] stopped FrameSource for %s@%d", deviceID, maxWidth)
	}
}

// CloseAll releases all resources regardless of ref counts.
func (rp *ResourcePool) CloseAll() {
	rp.mu.Lock()
	defer rp.mu.Unlock()

	for key, entry := range rp.frameSources {
		entry.source.Stop()
		delete(rp.frameSources, key)
	}
	for id, entry := range rp.clients {
		entry.client.Close()
		delete(rp.clients, id)
	}
}

func androidSerialForDeviceID(deviceID string) (string, bool) {
	return androidSerialForDevice(deviceID, "")
}

func androidSerialForDevice(deviceID, deviceType string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(deviceType)) {
	case "android":
		// Accept either explicit "android:<serial>" IDs or plain adb serials.
		if strings.HasPrefix(deviceID, "android:") {
			serial := strings.TrimSpace(strings.TrimPrefix(deviceID, "android:"))
			return serial, serial != ""
		}
		serial := strings.TrimSpace(deviceID)
		return serial, serial != ""
	case "emulator":
		if strings.HasPrefix(deviceID, "emulator-") && shouldUseAPKForEmulators() {
			return deviceID, true
		}
		return "", false
	case "chromeos", "ios-simulator":
		return "", false
	}

	// Explicit override: route any device ID through Android APK transport.
	// Example: "android:emulator-5554" or "android:R3CN90ABCDE"
	if strings.HasPrefix(deviceID, "android:") {
		serial := strings.TrimSpace(strings.TrimPrefix(deviceID, "android:"))
		return serial, serial != ""
	}

	// Auto-apply Android transport for emulators when regression-testing APK mode.
	if strings.HasPrefix(deviceID, "emulator-") && shouldUseAPKForEmulators() {
		return deviceID, true
	}

	// Physical Android serials are unprefixed and not "avd-*".
	if strings.HasPrefix(deviceID, "avd-") || deviceID == "chromeos" || strings.HasPrefix(deviceID, "chromeos:") {
		return "", false
	}
	if strings.HasPrefix(deviceID, "emulator-") {
		return "", false
	}
	return strings.TrimSpace(deviceID), strings.TrimSpace(deviceID) != ""
}

func shouldUseAPKForEmulators() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(useAPKForEmulatorEnvVar))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
