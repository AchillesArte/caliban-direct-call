/* DAT microphone PCM -> a replaceable WebRTC audio track in the iPhone WebView.
 *
 * The native Meta DAT stream supplies signed 16-bit, little-endian, interleaved
 * PCM. The browser's AudioBufferSourceNode performs sample-rate conversion; the
 * source rate and channel count accompany each frame, so 16/44.1/48 kHz input
 * is never mislabeled as a different recording format.
 *
 * Usage: const track = CalibanGlassesAudio.start({sampleRate:48000,channelCount:1});
 *        CalibanGlassesAudio.pushFrame(base64PCM, {sampleRate:48000,channelCount:1});
 *        await audioSender.replaceTrack(track);
 *        // On native disconnect, restore the original mic sender, then stop().
 */
(() => {
  'use strict';

  if (window.CalibanGlassesAudio) return;

  const SUPPORTED_SAMPLE_RATES = new Set([16000, 44100, 48000]);
  const MAX_CHANNELS = 2;
  const MAX_FRAME_MS = 120;
  const PREBUFFER_SECONDS = 0.065;
  const MAX_QUEUE_SECONDS = 0.220;
  const MAX_PENDING_SOURCES = 32;
  const MAX_FRAME_BYTES = 48000 * (MAX_FRAME_MS / 1000) * MAX_CHANNELS * 2;
  const MAX_FRAME_BASE64 = Math.ceil(MAX_FRAME_BYTES / 3) * 4 + 4;
  const MAX_CAPTURE_AGE_MS = 350;

  let current = null;
  let defaultRate = 48000;
  let defaultChannels = 1;
  let lastStats = emptyStats();

  function emptyStats() {
    return {
      accepted: 0,
      rejected: 0,
      droppedOld: 0,
      discardedQueued: 0,
      rebuffers: 0,
      lastFrameAt: null,
      lastSourceRate: null,
      lastChannelCount: null,
      lastCaptureTimeMs: null,
    };
  }

  function optionsFrom(rateOrOptions, channels) {
    if (typeof rateOrOptions === 'number') {
      return {sampleRate: rateOrOptions, channelCount: channels ?? defaultChannels};
    }
    return rateOrOptions && typeof rateOrOptions === 'object' ? rateOrOptions : {};
  }

  function validFormat(rate, channels) {
    return SUPPORTED_SAMPLE_RATES.has(rate) && Number.isInteger(channels) &&
      channels >= 1 && channels <= MAX_CHANNELS;
  }

  function createContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('This iPhone WebView cannot create an audio track.');
    try {
      return new AudioContextClass({sampleRate: 48000});
    } catch (_) {
      // Some iOS versions allow only the current hardware sample rate.
      return new AudioContextClass();
    }
  }

  function resume() {
    if (!current) return Promise.resolve();
    const context = current.context;
    return context.state === 'running' ? Promise.resolve() : context.resume();
  }

  function start(options = {}) {
    const requestedRate = options.sampleRate ?? 48000;
    const requestedChannels = options.channelCount ?? options.channels ?? 1;
    if (!validFormat(requestedRate, requestedChannels)) {
      throw new RangeError('Meta DAT PCM must contain one or two channels at 16000, 44100, or 48000 Hz.');
    }
    defaultRate = requestedRate;
    defaultChannels = requestedChannels;

    if (current && (current.context.state === 'closed' || current.track.readyState !== 'live')) stop();
    if (current?.track?.readyState === 'live') {
      // Starting twice must not produce another microphone track or context.
      void resume().catch(() => {});
      return current.track;
    }

    const context = createContext();
    let destination;
    try {
      destination = context.createMediaStreamDestination();
      const gain = context.createGain();
      gain.connect(destination);
      const track = destination.stream.getAudioTracks()[0];
      if (!track) throw new Error('Web Audio did not provide an outbound microphone track.');
      lastStats = emptyStats();
      current = {
        context, destination, gain, track,
        scheduled: new Map(), nextStart: 0, stats: lastStats,
      };
      // Call start() from the camera-selection gesture so iOS authorizes audio.
      // If the browser suspends audio later, the calling UI can invoke resume().
      void resume().catch(() => {});
      return track;
    } catch (error) {
      void context.close().catch(() => {});
      throw error;
    }
  }

  function reject(stats, old = false) {
    stats.rejected++;
    if (old) stats.droppedOld++;
    return false;
  }

  // Preserve only already-playing frames when a burst would exceed the maximum
  // queue latency. Their source nodes are allowed to finish; future audio is
  // discarded, and the freshest PCM starts after the short prebuffer again.
  function rebuffer(state, now) {
    let playingUntil = now;
    for (const [source, times] of state.scheduled) {
      if (times.start > now + 0.004) {
        try { source.stop(); } catch (_) { /* Already ended. */ }
        state.scheduled.delete(source);
        state.stats.discardedQueued++;
      } else {
        playingUntil = Math.max(playingUntil, times.end);
      }
    }
    state.nextStart = Math.max(now + PREBUFFER_SECONDS, playingUntil);
    state.stats.rebuffers++;
  }

  function pushFrame(base64PCM, rateOrOptions, channels) {
    const state = current;
    if (!state || state.track.readyState !== 'live') return false;
    const stats = state.stats;
    if (state.context.state !== 'running') {
      // A paused WebView has no running playback clock. Do not retain frames
      // that would play late when iOS resumes the audio session.
      void resume().catch(() => {});
      return reject(stats, true);
    }
    const options = optionsFrom(rateOrOptions, channels);
    const rate = options.sampleRate ?? defaultRate;
    const channelCount = options.channelCount ?? options.channels ?? defaultChannels;
    const captureTimeMs = options.timestampMs ?? options.captureTimeMs;

    if (!validFormat(rate, channelCount) || typeof base64PCM !== 'string' ||
        base64PCM.length === 0 || base64PCM.length > MAX_FRAME_BASE64) return reject(stats);

    if (Number.isFinite(captureTimeMs)) {
      if (captureTimeMs > 1e12 && Date.now() - captureTimeMs > MAX_CAPTURE_AGE_MS) {
        return reject(stats, true);
      }
      if (stats.lastCaptureTimeMs !== null && captureTimeMs < stats.lastCaptureTimeMs) {
        return reject(stats, true);
      }
    }

    let raw;
    try { raw = atob(base64PCM); } catch (_) { return reject(stats); }
    const byteStride = channelCount * 2;
    if (raw.length === 0 || raw.length > MAX_FRAME_BYTES || raw.length % byteStride !== 0) {
      return reject(stats);
    }
    const frameCount = raw.length / byteStride;
    const duration = frameCount / rate;
    if (duration * 1000 > MAX_FRAME_MS) return reject(stats);

    // Build a source-rate AudioBuffer, letting Web Audio resample at playback.
    // The PCM stays 16-bit until decoding; it is never base64-decoded twice.
    let buffer;
    try {
      buffer = state.context.createBuffer(channelCount, frameCount, rate);
      const data = Array.from({length: channelCount}, (_, index) => buffer.getChannelData(index));
      for (let frame = 0; frame < frameCount; frame++) {
        for (let channel = 0; channel < channelCount; channel++) {
          const i = (frame * channelCount + channel) * 2;
          const unsigned = raw.charCodeAt(i) | (raw.charCodeAt(i + 1) << 8);
          const signed = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
          data[channel][frame] = signed / 32768;
        }
      }
    } catch (_) { return reject(stats); }

    const now = state.context.currentTime;
    if (state.nextStart <= now + 0.005) {
      // After an underrun, do not place old PCM in an already elapsed slot.
      state.nextStart = now + PREBUFFER_SECONDS;
    }
    if (state.nextStart + duration > now + MAX_QUEUE_SECONDS ||
        state.scheduled.size >= MAX_PENDING_SOURCES) {
      rebuffer(state, now);
    }

    let source;
    try {
      source = state.context.createBufferSource();
      source.buffer = buffer;
      source.connect(state.gain);
      const when = state.nextStart;
      source.onended = () => {
        state.scheduled.delete(source);
        source.disconnect();
      };
      state.scheduled.set(source, {start: when, end: when + duration});
      source.start(when);
      state.nextStart = when + duration;
    } catch (_) {
      if (source) {
        state.scheduled.delete(source);
        source.disconnect();
      }
      return reject(stats);
    }

    stats.accepted++;
    stats.lastFrameAt = Date.now();
    stats.lastSourceRate = rate;
    stats.lastChannelCount = channelCount;
    if (Number.isFinite(captureTimeMs)) stats.lastCaptureTimeMs = captureTimeMs;
    return true;
  }

  function silence() {
    if (current) silenceState(current);
  }

  function stop() {
    const state = current;
    if (!state) return;
    current = null;
    silenceState(state);
    state.track.stop();
    state.gain.disconnect();
    void state.context.close().catch(() => {});
  }

  function silenceState(state) {
    for (const source of state.scheduled.keys()) {
      try { source.stop(); } catch (_) { /* Already ended. */ }
      source.disconnect();
    }
    state.scheduled.clear();
    state.nextStart = 0;
    state.stats.lastCaptureTimeMs = null;
  }

  function stats() {
    const state = current;
    return Object.freeze({
      ...lastStats,
      active: Boolean(state && state.track.readyState === 'live'),
      queueMs: state ? Math.max(0, (state.nextStart - state.context.currentTime) * 1000) : 0,
      scheduledSources: state?.scheduled.size ?? 0,
      contextState: state?.context.state ?? 'closed',
      playbackSampleRate: state?.context.sampleRate ?? null,
    });
  }

  window.CalibanGlassesAudio = Object.freeze({
    start,
    resume,
    pushFrame,
    silence,
    stop,
    stats,
    get context() { return current?.context ?? null; },
    get stream() { return current?.destination.stream ?? null; },
    get track() { return current?.track ?? null; },
  });
})();
