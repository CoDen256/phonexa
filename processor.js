class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.buffer, [ch.buffer]);
    return true;
  }
}
registerProcessor("pcm-processor", PCMProcessor);

B05039
B05035
B02050