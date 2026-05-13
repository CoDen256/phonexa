/**
 * audio-worklet.js — AudioWorkletProcessor for mic capture.
 *
 * Runs in the audio rendering thread (off the main UI thread), which
 * eliminates the jitter caused by ScriptProcessorNode competing with
 * rendering and WebSocket on the main thread.
 *
 * Accumulates Float32 samples into chunks of the requested size,
 * then postMessages each chunk back to the main thread for WebSocket sending.
 */
class ChunkProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._chunkSize = (options.processorOptions || {}).chunkSize || 4096;
    this._buf = [];
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) this._buf.push(ch[i]);

    while (this._buf.length >= this._chunkSize) {
      const chunk = new Float32Array(this._buf.splice(0, this._chunkSize));
      // Transfer ownership of the buffer (zero-copy)
      this.port.postMessage({ type: 'chunk', data: chunk }, [chunk.buffer]);
    }
    return true; // keep alive
  }
}

registerProcessor('chunk-processor', ChunkProcessor);