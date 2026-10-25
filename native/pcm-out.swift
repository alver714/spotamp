// pcm-out: plays raw PCM from stdin on the default output device.
//
//   <producer> | pcm-out
//
// Input: 32-bit float little-endian, stereo, 44100 Hz (what engine/dsp.mjs writes).
// Uses AudioQueue, so there are no third-party dependencies. Playback pulls
// from stdin at real-time pace, which gives the producer natural backpressure.
// Exits when stdin closes.

import AudioToolbox
import Foundation

let sampleRate = 44100.0
let channels: UInt32 = 2
let bytesPerFrame: UInt32 = 4 * channels
let framesPerBuffer: UInt32 = 1024 // ~23 ms per buffer
let bufferCount = 3                // ~70 ms queued in total

var format = AudioStreamBasicDescription(
  mSampleRate: sampleRate,
  mFormatID: kAudioFormatLinearPCM,
  mFormatFlags: kLinearPCMFormatFlagIsFloat | kLinearPCMFormatFlagIsPacked,
  mBytesPerPacket: bytesPerFrame,
  mFramesPerPacket: 1,
  mBytesPerFrame: bytesPerFrame,
  mChannelsPerFrame: channels,
  mBitsPerChannel: 32,
  mReserved: 0
)

let input = FileHandle.standardInput
let byteCount = Int(framesPerBuffer * bytesPerFrame)
var finished = false

// Fills one buffer from stdin. Blocks until the buffer is full or stdin ends.
func fill(_ buffer: AudioQueueBufferRef) -> Bool {
  var filled = 0
  let dst = buffer.pointee.mAudioData.assumingMemoryBound(to: UInt8.self)
  while filled < byteCount {
    let n = read(input.fileDescriptor, dst + filled, byteCount - filled)
    if n <= 0 { break }
    filled += n
  }
  if filled == 0 { return false }
  if filled < byteCount { memset(dst + filled, 0, byteCount - filled) }
  buffer.pointee.mAudioDataByteSize = UInt32(byteCount)
  return true
}

let callback: AudioQueueOutputCallback = { _, queue, buffer in
  if finished { return }
  if fill(buffer) {
    AudioQueueEnqueueBuffer(queue, buffer, 0, nil)
  } else {
    finished = true
    AudioQueueStop(queue, false)
    exit(0)
  }
}

var queue: AudioQueueRef?
guard AudioQueueNewOutput(&format, callback, nil, nil, nil, 0, &queue) == noErr, let queue else {
  FileHandle.standardError.write("pcm-out: cannot open audio output\n".data(using: .utf8)!)
  exit(1)
}

for _ in 0..<bufferCount {
  var buffer: AudioQueueBufferRef?
  AudioQueueAllocateBuffer(queue, UInt32(byteCount), &buffer)
  guard let buffer else { exit(1) }
  if !fill(buffer) { exit(0) }
  AudioQueueEnqueueBuffer(queue, buffer, 0, nil)
}

AudioQueueStart(queue, nil)
CFRunLoopRun()
