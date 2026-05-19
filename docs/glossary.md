- `audio` - an array of raw bytes in a specific format(wav,mp3), representing a sound (byte array)
- `audio_duration`  - duration of the audio/sound/file (ms)
- `sample` - one decoded snapshot of an audio(independent of format) (float64)
- `samples` - an array of snapshots/samples of an audio (float64 array of arbitrary size)
- `sample_rate` - samples per second, the conversion factor between sample counts and durations. (Hz)

- `chunk` - encoded sample array of fixed length for transferring audio over the wire from client (int16 array of size 2*chunk_samples)
- `chunk_samples` - length of a chunk in samples/how much samples encoded in a chunk (sample count)
- `ring` - sample array of fixed length for storing incoming decoded chunks (float64 array of size ring_samples)
- `ring_samples` - size of a ring in samples (sample count, usually equals segment_samples)


- `file` - audio saved on a disk (byte array and a path on a disk)
- `sound` - praat object loaded from file or sample array (parselmouth.Sound)


- `slice` - a sample array representing the trimmed part of an original audio sample array (float64 array of size slice_samples)
- `slice_samples` - the number of samples within the slice (sample count)
- `slice_duration` - duration of the slice (ms)
- `slice_start_ms`- an absolute time point within the original audio, where the slice starts (ms in [0:audio_duration])
- `slice_start` - a relative time point within the original audio, where the slice starts (fraction of audio duration [0.0-1.0])
- `slice_end_ms` an absolute time point within the original audio, where the slice ends (ms [0:audio_duration])
- `slice_end` a relative time point within the original audio, where the slice ends (fraction of audio duration [0.0-1.0])

- `segment` - a part of sample array(chunk samples/slice samples), representing a single input unit of praat analysis (float64 array of size segment_samples)
- `segment_samples` - the number of samples within the segment (sample count)
- `segment_duration` - duration of the segment (ms)
- `segment_at_ms` - an absolute time point of the *segment end* within the original audio/slice duration (ms)
- `segment_at` - an absolute point of the *segment end* within the original audio/slice sample array (sample count)
- `segment_index` - the index number of the segment  within the original audio/slice (segment count)
- `segment_step_ms` - a step of analysis within the original slice/audio = the duration between each segment (ms)
- `segment_step` - a step of analysis within the original slice/audio = the number of samples between each segment (sample count)

- `frame` - computed formant values of a given segment, representing a single output unit of praat analysis.