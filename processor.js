// processor.js  — served as a separate file
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];          // mono Float32Array, 128 samples
    if (ch) this.port.postMessage(ch.buffer, [ch.buffer]);
    return true;
  }
}
registerProcessor("pcm-processor", PCMProcessor);