/* Caliban phone client: direct, paired WebRTC media via a trusted gateway. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const TOKEN_KEY = 'caliban.phone.pairing.v1';
  const TOKEN_PATTERN = /^[a-fA-F0-9]{64}$/;
  const WEBSOCKET_OPEN = 1;
  const FRAME_INTERVAL_MS = 3000;
  const GLASSES_VIDEO_FPS = 30;
  const GLASSES_AUDIO_STALE_MS = 1800;
  const MAX_WS_BUFFERED_BYTES = 2 * 1024 * 1024;
  const MAX_JPEG_BASE64_LENGTH = 800 * 1024;

  function phoneVideoConstraints(facingMode) {
    // Prefer the same portrait dimensions as Meta DAT's high resolution feed.
    // Every numeric field is ideal, so cameras without this mode can still open.
    return {
      facingMode: {ideal:facingMode},
      width: {ideal:720},
      height: {ideal:1280},
      aspectRatio: {ideal:9/16},
      frameRate: {ideal:GLASSES_VIDEO_FPS},
    };
  }

  const ui = {
    connectionChip: $('connectionChip'), connectionText: $('connectionText'),
    stageCenter: $('stageCenter'), stageTitle: $('stageTitle'), stageMessage: $('stageMessage'),
    remoteVideo: $('remoteVideo'), localVideo: $('localVideo'), localWrap: $('localWrap'),
    recordingChip: $('recordingChip'), recordingNotice: $('recordingNotice'),
    error: $('error'), pairPanel: $('pairPanel'), pairForm: $('pairForm'),
    pairToken: $('pairToken'), callPanel: $('callPanel'), desktopState: $('desktopState'),
    callDescription: $('callDescription'),
    callButton: $('callButton'), hangupButton: $('hangupButton'), controls: $('controls'),
    muteButton: $('muteButton'), videoButton: $('videoButton'), flipButton: $('flipButton'),
    audioButton: $('audioButton'), duration: $('duration'), installButton: $('installButton'),
    installHelp: $('installHelp'), unpairButton: $('unpairButton'),
    captionStatus: $('captionStatus'), captionList: $('captionList'),
    captionPlaceholder: $('captionPlaceholder'), copyCaptions: $('copyCaptions'),
    glassesPanel: $('glassesPanel'), glassesButton: $('glassesButton'), glassesConnect: $('glassesConnect'), glassesStatus: $('glassesStatus'),
    glassesUpdate: $('glassesUpdate'), glassesUpdateHelp: $('glassesUpdateHelp'),
    glassesRecovery: $('glassesRecovery'), cameraSourceLabel: $('cameraSourceLabel'),
  };

  let token = '';
  let ws = null;
  let reconnectTimer = null;
  let resolvingEndpoint = false;
  let hiddenAt = 0;
  let lastResumeAt = 0;
  let endpointRefreshMode = false;
  let githubEndpointCheckedAt = 0;
  let githubSignalUrl = '';
  let ringTimer = null;
  let durationTimer = null;
  let reconnectAttempts = 0;
  let sessionNumber = 0;
  let desktopOnline = false;
  let recordingActive = false;
  let recordingSessionId = null;
  let frameTimer = null;
  let frameCanvas = null;
  // This paired phone is the owner's personal lifelog device. Recording
  // requests originate from the paired desktop and are accepted for a call
  // without prompting again. An active recording remains plainly indicated.
  let socketReady = false;
  let connectedAt = 0;
  let callPhase = 'idle'; // idle | preparing | ringing | negotiating | connected
  let cameraFacing = 'user';
  let microphoneMuted = false;
  let cameraDisabled = false;
  let audioOnly = false;
  let peer = null;
  // A persistent outbound video sender lets the call change cameras without
  // requiring another SDP negotiation, including after an audio-only start.
  let videoSender = null;
  let audioSender = null;
  let localStream = null;
  let phoneMicTrack = null;
  let glassesAudioTrack = null;
  let glassesAudioLastAt = 0;
  let glassesAudioSelected = false;
  let glassesAudioSampleRate = null;
  let glassesAudioSwitching = Promise.resolve();
  let glassesAudioWatchdog = null;
  let remoteStream = null;
  // The Meta DAT SDK runs in the native iOS wrapper. Safari cannot see its
  // camera as a getUserMedia device; native JPEGs are drawn into this track.
  const nativeGlasses = window.webkit?.messageHandlers?.calibanGlasses;
  let glassesRequested = false;
  let glassesActive = false;
  let glassesCanvas = null;
  let glassesStream = null;
  let glassesTrack = null;
  let glassesFrameRequester = null;
  let phoneCameraTrack = null;
  let glassesFrameBusy = false;
  let glassesFrameLastAt = 0;
  let glassesStatus = 'idle';
  let glassesNeedsDatUpdate = false;
  let glassesSwitching = Promise.resolve();
  let glassesSwitchQueued = false;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let pendingCandidates = [];
  let deferredInstallPrompt = null;
  const captions = [];
  const CAPTION_LIMIT = 35;

  // Show the source choice in the native shell; explain the installation
  // requirement if the page is opened in Safari or the Home Screen web app.
  ui.glassesPanel.hidden = false;
  if (!nativeGlasses) {
    ui.glassesButton.hidden = true;
    ui.glassesConnect.hidden = true;
    ui.glassesUpdate.hidden = true;
    ui.glassesUpdateHelp.hidden = true;
    ui.glassesStatus.textContent = 'Meta glasses video requires the native Caliban iPhone app. Safari and Home Screen web apps cannot access the Meta Wearables camera SDK.';
  } else {
    // Keep the live Bluetooth permission and Meta connection diagnostics
    // visible in the native app without requiring a second disclosure tap.
    ui.glassesPanel.open = true;
  }

  function postGlasses(action) {
    if (!nativeGlasses) return false;
    try { nativeGlasses.postMessage({action}); return true; }
    catch (error) { ui.glassesStatus.textContent = `Glasses connection failed: ${error.message}`; return false; }
  }

  function glassesInfo(text) {
    if (ui.glassesStatus) ui.glassesStatus.textContent = text;
  }

  function updateGlassesButton() {
    if (!nativeGlasses) return;
    ui.glassesButton.setAttribute('aria-pressed', String(glassesRequested));
    ui.glassesButton.textContent = glassesRequested && glassesStatus === 'connecting'
      ? 'Cancel Meta camera connection'
      : glassesRequested ? 'Use iPhone camera'
      : ['error', 'dat_update_required'].includes(glassesStatus) ? 'Retry Meta glasses camera' : 'Use Meta glasses camera';
    // A native Meta discovery or camera-permission prompt may stall. Keep the
    // cancellation action available so the user can stop it immediately.
    ui.glassesButton.disabled = glassesStatus === 'connecting' && !glassesRequested;
    ui.glassesRecovery.hidden = !['error', 'dat_update_required'].includes(glassesStatus);
    ui.glassesUpdate.hidden = glassesStatus !== 'dat_update_required';
    ui.glassesUpdateHelp.hidden = !glassesNeedsDatUpdate;
    ui.flipButton.disabled = glassesRequested || !localStream || cameraDisabled || localStream.getVideoTracks().length === 0;
  }

  function scheduleGlassesSwitch(fn) {
    glassesSwitching = glassesSwitching.catch(() => {}).then(fn).catch(error => {
      glassesInfo(`Camera source change failed: ${error.message}`);
      displayError(`Could not switch camera: ${error.message}`);
    });
    return glassesSwitching;
  }

  // DAT's audioFramePublisher supplies the actual glasses microphone. The
  // separate audio module buffers and resamples PCM into a real WebRTC track.
  function prepareGlassesAudio() {
    if (!nativeGlasses || !window.CalibanGlassesAudio) return false;
    try {
      glassesAudioTrack = window.CalibanGlassesAudio.start({sampleRate:48000,channelCount:1});
      if (glassesAudioTrack) glassesAudioTrack.enabled = !microphoneMuted;
      // Called from the user's Start Call or Use Meta glasses tap to permit
      // WebKit audio-context activation; failure preserves the phone mic.
      void window.CalibanGlassesAudio.resume().catch(() => {});
      return Boolean(glassesAudioTrack);
    } catch (error) {
      console.warn('Meta glasses audio output unavailable', error);
      return false;
    }
  }

  // The receiver distinguishes native glasses microphone audio from the
  // always-available iPhone fallback by the track actually selected.
  function reportMediaSources() {
    if (!socketReady || callPhase === 'idle') return;
    send({
      type: 'source_status',
      camera_source: glassesActive ? 'meta_glasses' : 'iphone_camera',
      audio_source: glassesAudioSelected ? 'meta_glasses' : 'iphone_microphone',
      sample_rate: glassesAudioSelected ? glassesAudioSampleRate : null,
    });
  }

  function preferFullResolutionVideo() {
    if (!videoSender || !glassesActive) return;
    try {
      if (glassesTrack) glassesTrack.contentHint = 'detail';
      const parameters = videoSender.getParameters();
      if (parameters.encodings?.length) {
        parameters.degradationPreference = 'maintain-resolution';
        for (const encoding of parameters.encodings) {
          encoding.maxBitrate = 8_000_000;
          encoding.maxFramerate = GLASSES_VIDEO_FPS;
          encoding.scaleResolutionDownBy = 1;
        }
        void videoSender.setParameters(parameters).catch(() => {});
      }
    } catch (_) { /* Older WebKit releases use the browser's defaults. */ }
  }

  function switchMicrophone(track) {
    const connection = peer;
    const sender = audioSender;
    if (!sender || !track) return Promise.resolve();
    glassesAudioSwitching = glassesAudioSwitching.catch(() => {}).then(async () => {
      if (connection !== peer || sender !== audioSender || !localStream) return;
      await sender.replaceTrack(track);
      if (connection !== peer || sender !== audioSender || !localStream) return;
      glassesAudioSelected = track === glassesAudioTrack;
      reportMediaSources();
      if (glassesActive && glassesRequested) glassesInfo(glassesAudioSelected
        ? 'Meta glasses camera and microphone are sending live video and audio to Caliban.'
        : 'Meta glasses camera is live. The iPhone microphone supplies audio.');
    }).catch(error => {
      glassesInfo(`Microphone source switch failed: ${error.message}. Using the available audio source.`);
    });
    return glassesAudioSwitching;
  }

  function restorePhoneMicrophone() {
    window.CalibanGlassesAudio?.silence();
    glassesAudioLastAt = 0;
    glassesAudioSampleRate = null;
    return phoneMicTrack ? switchMicrophone(phoneMicTrack) : Promise.resolve();
  }

  function stopGlassesAudio() {
    clearInterval(glassesAudioWatchdog);
    glassesAudioWatchdog = null;
    glassesAudioSelected = false;
    glassesAudioLastAt = 0;
    glassesAudioSampleRate = null;
    window.CalibanGlassesAudio?.stop();
    glassesAudioTrack = null;
  }

  function receiveGlassesAudio(base64PCM, sampleRate) {
    if (!nativeGlasses || !glassesRequested || !localStream || callPhase === 'idle' ||
        ![16000, 44100, 48000].includes(sampleRate) || typeof base64PCM !== 'string' ||
        !window.CalibanGlassesAudio || !glassesAudioTrack) return false;
    try {
      if (window.CalibanGlassesAudio.context?.state !== 'running') {
        void window.CalibanGlassesAudio.resume().catch(() => {});
        return false;
      }
      if (!window.CalibanGlassesAudio.pushFrame(base64PCM, {sampleRate,channelCount:1})) return false;
      glassesAudioLastAt = Date.now();
      glassesAudioSampleRate = sampleRate;
      if (glassesActive && !glassesAudioSelected && audioSender && glassesAudioTrack &&
          audioSender.track !== glassesAudioTrack) void switchMicrophone(glassesAudioTrack);
      if (!glassesAudioWatchdog) {
        glassesAudioWatchdog = setInterval(() => {
          if (glassesAudioSelected && Date.now() - glassesAudioLastAt > GLASSES_AUDIO_STALE_MS) {
            void restorePhoneMicrophone();
          }
        }, 500);
      }
      return true;
    } catch (error) {
      console.warn('Meta glasses PCM could not be decoded', error);
      return false;
    }
  }

  function createGlassesCanvasTrack() {
    if (!glassesCanvas || glassesTrack) return;
    // Where supported, request one encoded frame for each fresh DAT image.
    // A 30-Hz timer could otherwise sample between 30-Hz native updates and
    // retain duplicate frames instead of recent source frames.
    try {
      const manualStream = glassesCanvas.captureStream(0);
      const manualTrack = manualStream.getVideoTracks()[0];
      if (manualTrack && typeof manualTrack.requestFrame === 'function') {
        glassesStream = manualStream;
        glassesTrack = manualTrack;
        glassesFrameRequester = manualTrack;
      } else {
        manualStream.getTracks().forEach(track => track.stop());
      }
    } catch (_) { /* Older WebKit has no manual canvas frame capture. */ }
    if (!glassesTrack) {
      glassesStream = glassesCanvas.captureStream(GLASSES_VIDEO_FPS);
      glassesTrack = glassesStream.getVideoTracks()[0] || null;
      glassesFrameRequester = null;
    }
    if (!glassesTrack) throw new Error('No video track could be created for the glasses.');
    glassesTrack.contentHint = 'detail';
  }

  function requestGlassesFrame() {
    if (!glassesFrameRequester) return;
    try {
      glassesFrameRequester.requestFrame();
    } catch (_) {
      // A WebKit implementation can expose requestFrame but disallow it for
      // the active capture. Keep WebRTC usable through its timed capture path.
      const old = glassesTrack;
      const fallbackStream = glassesCanvas.captureStream(GLASSES_VIDEO_FPS);
      const replacement = fallbackStream.getVideoTracks()[0];
      if (!replacement) throw new Error('Neither manual nor timed camera capture is supported.');
      glassesStream = fallbackStream;
      glassesTrack = replacement;
      glassesTrack.contentHint = 'detail';
      glassesFrameRequester = null;
      if (localStream?.getTracks().includes(old)) {
        localStream.removeTrack(old);
        localStream.addTrack(replacement);
      }
      if (videoSender?.track === old) void videoSender.replaceTrack(replacement).catch(error => {
        displayError(`Live camera fallback failed: ${error.message}`);
      });
      old?.stop();
    }
  }

  async function useGlassesTrack() {
    if (!glassesRequested || !glassesTrack || !localStream || callPhase === 'idle' || glassesActive) return;
    const existing = localStream.getVideoTracks()[0] || null;
    const stream = localStream;
    const connection = peer;
    if (videoSender) await videoSender.replaceTrack(glassesTrack);
    if (stream !== localStream || connection !== peer || !glassesRequested || callPhase === 'idle') return;
    // The glasses are now the selected camera. Release the iPhone camera
    // instead of continuing to capture an unused second video source.
    if (phoneCameraTrack && phoneCameraTrack !== glassesTrack) phoneCameraTrack.stop();
    if (existing && existing !== glassesTrack && existing !== phoneCameraTrack && existing.readyState === 'live') {
      existing.stop();
    }
    if (existing && existing !== glassesTrack) localStream.removeTrack(existing);
    if (!localStream.getTracks().includes(glassesTrack)) localStream.addTrack(glassesTrack);
    glassesTrack.enabled = !cameraDisabled;
    ui.localVideo.srcObject = localStream;
    ui.localVideo.classList.add('back-camera');
    void ui.localVideo.play().catch(() => {});
    glassesActive = true;
    preferFullResolutionVideo();
    audioOnly = false;
    ui.cameraSourceLabel.textContent = 'META GLASSES';
    glassesInfo('Meta glasses camera is sending live video to Caliban. Audio uses the glasses microphone when available, with iPhone fallback.');
    reportMediaSources();
    updateDisplay();
  }

  async function usePhoneTrack() {
    await restorePhoneMicrophone();
    if (!localStream) {
      glassesActive = false;
      ui.cameraSourceLabel.textContent = 'PHONE CAMERA';
      return;
    }
    if (!glassesActive && videoSender?.track !== glassesTrack &&
        localStream.getVideoTracks().some(track => track.readyState === 'live')) {
      ui.cameraSourceLabel.textContent = 'PHONE CAMERA';
      return;
    }
    let replacement = phoneCameraTrack?.readyState === 'live' ? phoneCameraTrack : null;
    let createdReplacement = false;
    if (!replacement) {
      try {
        const phone = await navigator.mediaDevices.getUserMedia({audio:false,video:phoneVideoConstraints(cameraFacing)});
        replacement = phone.getVideoTracks()[0];
        createdReplacement = Boolean(replacement);
      } catch (error) { glassesInfo(`Phone camera unavailable: ${error.message}`); }
    }
    if (!replacement) {
      // A stopped DAT feed must not remain attached as the outbound source.
      // Keep the microphone call alive when the phone camera cannot reopen.
      if (glassesActive && !glassesRequested) {
        if (videoSender) await videoSender.replaceTrack(null);
        if (glassesTrack && localStream.getTracks().includes(glassesTrack)) localStream.removeTrack(glassesTrack);
        glassesActive = false;
        audioOnly = true;
        ui.localVideo.srcObject = localStream;
        ui.cameraSourceLabel.textContent = 'CAMERA UNAVAILABLE';
        updateDisplay();
      }
      glassesInfo('The iPhone camera could not reopen. Microphone audio remains connected; try switching cameras again.');
      return;
    }
    const stream = localStream;
    const connection = peer;
    try {
      if (videoSender) await videoSender.replaceTrack(replacement);
    } catch (error) {
      if (createdReplacement) replacement.stop();
      throw error;
    }
    if (stream !== localStream || connection !== peer || callPhase === 'idle') {
      if (createdReplacement) replacement.stop();
      return;
    }
    phoneCameraTrack = replacement;
    if (glassesTrack && localStream.getTracks().includes(glassesTrack)) localStream.removeTrack(glassesTrack);
    if (replacement && !localStream.getTracks().includes(replacement)) localStream.addTrack(replacement);
    glassesActive = false;
    audioOnly = false;
    ui.cameraSourceLabel.textContent = 'PHONE CAMERA';
    reportMediaSources();
    ui.localVideo.srcObject = localStream;
    ui.localVideo.classList.toggle('back-camera', cameraFacing === 'environment');
    void ui.localVideo.play().catch(() => {});
    updateDisplay();
  }

  async function disableGlasses() {
    glassesRequested = false;
    glassesStatus = 'idle';
    glassesNeedsDatUpdate = false;
    updateGlassesButton();
    postGlasses('stop');
    await restorePhoneMicrophone();
    await scheduleGlassesSwitch(usePhoneTrack);
    glassesInfo('Using the iPhone camera.');
  }

  // This bridge exists only inside the native Caliban iOS app. Frames originate
  // in an explicit Meta SDK streaming session with Meta's camera permission.
  window.CalibanGlassesBridge = {
    onStatus(state, message) {
      if (!nativeGlasses) return;
      glassesStatus = ['connecting', 'streaming', 'idle', 'error', 'dat_update_required'].includes(state) ? state : 'idle';
      glassesNeedsDatUpdate = glassesStatus === 'dat_update_required' ||
        (glassesStatus === 'error' && typeof message === 'string' && message.includes('The DAT app on the glasses needs an update'));
      if (glassesStatus === 'error' || glassesStatus === 'dat_update_required') ui.glassesPanel.open = true;
      // A native stop can occur during an iOS app switch, before the glasses
      // have sent their first frame. Clear the pending choice in that case too.
      if (glassesStatus === 'error' || glassesStatus === 'dat_update_required' || glassesStatus === 'idle') {
        void restorePhoneMicrophone();
        if (glassesRequested) {
          glassesRequested = false;
          void scheduleGlassesSwitch(usePhoneTrack);
        }
      }
      glassesInfo(glassesStatus === 'streaming' && glassesActive
        ? (glassesAudioSelected
          ? 'Meta glasses camera and microphone are sending live video and audio to Caliban.'
          : 'Meta glasses camera is live. Audio uses the glasses microphone when available, with iPhone fallback.')
        : (typeof message === 'string' && message ? message : `Meta glasses: ${glassesStatus}`));
      updateGlassesButton();
    },
    onFrame(base64Jpeg) {
      if (!nativeGlasses || !glassesRequested || typeof base64Jpeg !== 'string' ||
          base64Jpeg.length > 350000 || glassesFrameBusy) return false;
      glassesFrameBusy = true;
      const frame = new Image();
      frame.onload = () => {
        try {
          if (!glassesRequested) return;
          if (!glassesCanvas) {
            glassesCanvas = document.createElement('canvas');
            glassesCanvas.width = frame.naturalWidth;
            glassesCanvas.height = frame.naturalHeight;
          }
          if (glassesCanvas.width !== frame.naturalWidth || glassesCanvas.height !== frame.naturalHeight) {
            glassesCanvas.width = frame.naturalWidth;
            glassesCanvas.height = frame.naturalHeight;
          }
          const context = glassesCanvas.getContext('2d', {alpha:false});
          if (!context) throw new Error('Camera canvas unavailable.');
          context.drawImage(frame, 0, 0);
          glassesFrameLastAt = Date.now();
          if (!glassesTrack) {
            if (typeof glassesCanvas.captureStream !== 'function') throw new Error('This iOS WebView cannot transmit canvas video.');
            createGlassesCanvasTrack();
          }
          requestGlassesFrame();
          if (callPhase !== 'idle' && localStream && !glassesActive && !glassesSwitchQueued) {
            glassesSwitchQueued = true;
            void scheduleGlassesSwitch(useGlassesTrack).finally(() => { glassesSwitchQueued = false; });
          }
          else if (!glassesActive && callPhase === 'idle') {
            glassesInfo('Meta glasses camera ready. Start a call to send its view.');
          }
        } catch (error) {
          glassesRequested = false;
          postGlasses('stop');
          glassesInfo(`Meta glasses unavailable: ${error.message}`);
          updateGlassesButton();
        } finally { glassesFrameBusy = false; }
      };
      frame.onerror = () => { glassesFrameBusy = false; glassesInfo('Could not decode a glasses video frame.'); };
      frame.src = `data:image/jpeg;base64,${base64Jpeg}`;
      return true;
    },
    onAudio(base64PCM, sampleRate) {
      return receiveGlassesAudio(base64PCM, sampleRate);
    },
  };

  ui.glassesButton.addEventListener('click', () => {
    if (!nativeGlasses) return;
    if (glassesRequested) { void disableGlasses(); return; }
    prepareGlassesAudio();
    glassesRequested = true;
    glassesStatus = 'connecting';
    glassesNeedsDatUpdate = false;
    ui.glassesRecovery.hidden = true;
    glassesInfo('Connecting to the Meta glasses through the Meta AI app…');
    updateGlassesButton();
    if (!postGlasses('start')) {
      glassesRequested = false;
      glassesStatus = 'error';
      updateGlassesButton();
    }
  });
  ui.glassesConnect.addEventListener('click', () => {
    if (!nativeGlasses) return;
    glassesInfo('Opening Meta AI to register the glasses with this Caliban app…');
    postGlasses('connect');
  });
  ui.glassesUpdate.addEventListener('click', () => {
    if (!nativeGlasses) return;
    glassesInfo('Opening the DAT app update screen in Meta AI…');
    postGlasses('update-dat');
  });

  function resetCaptions() {
    captions.length = 0;
    ui.captionList.replaceChildren();
    const placeholder = document.createElement('span');
    placeholder.className = 'caption-line';
    placeholder.textContent = 'Listening for speech…';
    ui.captionList.append(placeholder);
    ui.copyCaptions.disabled = true;
  }

  function appendCaption(message) {
    if (!recordingActive || !message || !['me', 'others'].includes(message.speaker) || !message.text) return;
    if (recordingSessionId && message.session_id !== recordingSessionId) return;
    const speaker = message.speaker === 'me' ? 'You' : 'Desktop';
    if (!captions.length) ui.captionList.replaceChildren();
    const content = String(message.text);
    captions.push(`${speaker}: ${content}`);
    if (captions.length > CAPTION_LIMIT) { captions.shift(); ui.captionList.firstChild?.remove(); }
    const nearEnd = ui.captionList.scrollHeight - ui.captionList.scrollTop - ui.captionList.clientHeight < 45;
    const entry = document.createElement('div'); entry.className = 'caption-line';
    const heading = document.createElement('strong');heading.textContent = speaker;
    const phrase = document.createElement('span'); phrase.textContent = content;
    entry.append(heading,phrase);
    ui.captionList.append(entry);
    ui.copyCaptions.disabled = false;
    if (nearEnd) ui.captionList.scrollTop = ui.captionList.scrollHeight;
  }

  function displayError(message) {
    ui.error.textContent = message;
    ui.error.hidden = !message;
  }

  function status(text, level = 'offline') {
    ui.connectionText.textContent = text;
    ui.connectionChip.dataset.status = level;
  }

  function send(message) {
    if (!ws || ws.readyState !== WEBSOCKET_OPEN || !socketReady) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      displayError(`Could not send signalling message: ${error.message}`);
      return false;
    }
  }

  // Capture at the source device. The selected track can be the iPhone camera
  // or the native Meta SDK canvas; no desktop video decoding is required.
  function sendFrame() {
    if (!recordingActive || callPhase === 'idle' || cameraDisabled || !localStream ||
        !ws || ws.readyState !== WEBSOCKET_OPEN || !socketReady ||
        ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) return;
    const activeTrack = localStream.getVideoTracks().find(track => track.readyState === 'live' && track.enabled);
    if (!activeTrack) return;
    let source;
    let width;
    let height;
    let cameraSource;
    if (glassesActive && activeTrack === glassesTrack) {
      if (!glassesCanvas || Date.now() - glassesFrameLastAt > 5000) return;
      source = glassesCanvas;
      width = source.width;
      height = source.height;
      cameraSource = 'meta_glasses';
    } else if (!glassesActive && activeTrack === phoneCameraTrack) {
      source = ui.localVideo;
      if (source.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      width = source.videoWidth;
      height = source.videoHeight;
      cameraSource = 'iphone_camera';
    } else return; // A camera source is changing; never upload a stale frame.
    if (!width || !height) return;
    const maxWidth = width >= height ? 1280 : 720;
    const maxHeight = width >= height ? 720 : 1280;
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    try {
      if (!frameCanvas) frameCanvas = document.createElement('canvas');
      let encoded = '';
      // Retain readable detail where possible; reduce quality or dimensions
      // on unusually complex frames to meet the server's 600 KiB JPEG cap.
      capture: for (const reduction of [1, 0.75, 0.5]) {
        const targetWidth = Math.max(1, Math.round(width * scale * reduction));
        const targetHeight = Math.max(1, Math.round(height * scale * reduction));
        if (frameCanvas.width !== targetWidth) frameCanvas.width = targetWidth;
        if (frameCanvas.height !== targetHeight) frameCanvas.height = targetHeight;
        const context = frameCanvas.getContext('2d', {alpha:false});
        if (!context) return;
        context.drawImage(source, 0, 0, targetWidth, targetHeight);
        for (const quality of [0.72, 0.55, 0.38]) {
          const jpeg = frameCanvas.toDataURL('image/jpeg', quality);
          encoded = jpeg.startsWith('data:image/jpeg;base64,') ? jpeg.slice(23) : '';
          if (encoded && encoded.length <= MAX_JPEG_BASE64_LENGTH) break capture;
        }
      }
      if (!encoded || encoded.length > MAX_JPEG_BASE64_LENGTH) return;
      send({type:'frame', data:encoded, camera_source:cameraSource,
            camera_facing:cameraSource === 'iphone_camera' ? cameraFacing : null});
    } catch (error) {
      console.warn('Could not capture the selected phone camera', error);
    }
  }

  function stopFrameCapture() {
    if (frameTimer) clearInterval(frameTimer);
    frameTimer = null;
  }

  function startFrameCapture() {
    if (frameTimer || !recordingActive || callPhase === 'idle') return;
    frameTimer = setInterval(sendFrame, FRAME_INTERVAL_MS);
    sendFrame();
  }

  function pairedTokenFromStorage() {
    try {
      const saved = localStorage.getItem(TOKEN_KEY);
      if (saved) return saved;
      // iOS Home Screen apps have isolated localStorage. Safari copies some
      // first-party cookies at installation; a brief install-only cookie
      // transfers the initial pairing once, then is erased from the app.
      if (location.hostname.endsWith('.github.io')) {
        const cookie = document.cookie.split('; ').find(item => item.startsWith('caliban_install='));
        if (cookie) {
          const candidate = cleanToken(decodeURIComponent(cookie.split('=').slice(1).join('=')));
          document.cookie = `caliban_install=; Max-Age=0; Path=${location.pathname.replace(/[^/]*$/, '')}; Secure; SameSite=Strict`;
          if (TOKEN_PATTERN.test(candidate)) {
            localStorage.setItem(TOKEN_KEY, candidate);
            return candidate;
          }
        }
      }
      return '';
    } catch (_) { return ''; }
  }

  function saveToken(value) {
    try { localStorage.setItem(TOKEN_KEY, value); }
    catch (_) { displayError('Private browsing prevented saving this pairing. Keep the pairing link to reconnect.'); }
    if (location.hostname.endsWith('.github.io') &&
        !window.matchMedia('(display-mode: standalone)').matches && TOKEN_PATTERN.test(value)) {
      // Expires in 10 minutes. Only created for a one-time Safari -> iOS PWA
      // migration, never stored in the public GitHub repository.
      document.cookie = `caliban_install=${encodeURIComponent(value)}; Max-Age=600; Path=${location.pathname.replace(/[^/]*$/, '')}; Secure; SameSite=Strict`;
    }
  }

  function forgetToken() {
    try { localStorage.removeItem(TOKEN_KEY); }
    catch (_) { /* Private browsing may prohibit local storage. */ }
    if (location.hostname.endsWith('.github.io')) {
      document.cookie = `caliban_install=; Max-Age=0; Path=${location.pathname.replace(/[^/]*$/, '')}; Secure; SameSite=Strict`;
    }
  }

  function cleanToken(value) { return String(value || '').trim().toLowerCase(); }

  function tokenFromFragment() {
    if (!location.hash.startsWith('#')) return '';
    const params = new URLSearchParams(location.hash.slice(1));
    const proposed = cleanToken(params.get('pair'));
    if (params.has('pair')) {
      // Prevent accidental copying of pairing secrets from the address bar.
      history.replaceState(null, '', location.pathname + location.search);
      if (!TOKEN_PATTERN.test(proposed)) displayError('The pairing link contains an invalid key. Enter the key manually.');
    }
    return TOKEN_PATTERN.test(proposed) ? proposed : '';
  }

  function resetPresence() {
    socketReady = false;
    desktopOnline = false;
    ui.desktopState.textContent = 'Desktop unavailable';
    ui.desktopState.classList.remove('online');
    updateDisplay();
  }

  function updateDisplay() {
    const paired = Boolean(token);
    const busy = callPhase !== 'idle';
    ui.pairPanel.hidden = paired;
    ui.callPanel.hidden = !paired;
    ui.unpairButton.hidden = !paired || busy;
    ui.controls.hidden = !busy;
    ui.callButton.hidden = busy;
    ui.hangupButton.hidden = !busy;
    ui.callButton.disabled = !socketReady || !desktopOnline || busy;
    ui.muteButton.disabled = !localStream;
    ui.videoButton.disabled = !localStream || localStream.getVideoTracks().length === 0;
    ui.flipButton.disabled = glassesRequested || !localStream || cameraDisabled || localStream.getVideoTracks().length === 0;
    const activeCamera = Boolean(localStream && !cameraDisabled &&
      localStream.getVideoTracks().some(track => track.readyState === 'live' && track.enabled));
    ui.localWrap.classList.toggle('show', busy && activeCamera);
    ui.recordingChip.hidden = !recordingActive;
    if (busy) {
      const labels = {
        preparing: 'Requesting camera and microphone…',
        ringing: 'Calling your desktop…',
        negotiating: 'Establishing secure media…',
        connected: 'Connected directly to Caliban',
      };
      ui.callDescription.textContent = `${audioOnly ? 'Audio only · ' : ''}${labels[callPhase]}`;
      ui.stageTitle.textContent = callPhase === 'connected' ? 'Connected' : 'Calling Caliban';
      ui.stageMessage.textContent = cameraDisabled ? 'Camera paused. Microphone remains connected.'
        : audioOnly && callPhase === 'connected' ? 'Microphone connected. Your camera is unavailable.' : labels[callPhase];
      ui.stageCenter.classList.toggle('in-call', activeCamera &&
        ui.localVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
    } else {
      ui.stageCenter.classList.remove('in-call');
      ui.stageTitle.textContent = 'Phone camera standby';
      ui.stageMessage.textContent = paired
        ? (desktopOnline ? 'Call Caliban to send live camera video and microphone audio.' : 'Open Caliban on your desktop to start a call.')
        : 'Pair your iPhone to share camera video and spoken dialogue during a call.';
      ui.callDescription.textContent = socketReady
        ? (desktopOnline ? 'Your desktop is ready to receive live camera video and microphone audio.' : 'Waiting for the Caliban desktop to connect.')
        : 'Connecting to the secure signalling service…';
    }
    if (!paired) status('Not paired');
    else if (busy) status(callPhase === 'connected' ? 'On a call' : 'Connecting', callPhase === 'connected' ? 'online' : 'calling');
    else if (socketReady) status(desktopOnline ? 'Desktop online' : 'Desktop offline', desktopOnline ? 'online' : 'offline');
    else status('Reconnecting', 'offline');
  }

  function setDesktopOnline(online) {
    desktopOnline = online === true;
    ui.desktopState.textContent = desktopOnline ? 'Desktop online' : 'Desktop offline';
    ui.desktopState.classList.toggle('online', desktopOnline);
    if (!desktopOnline && callPhase === 'ringing') {
      endCall(false);
      displayError('The desktop disconnected before answering.');
    }
    updateDisplay();
  }

  function setRecording(active, sessionId = null) {
    const wasRecording = recordingActive;
    recordingActive = active === true && callPhase !== 'idle';
    recordingSessionId = recordingActive && typeof sessionId === 'string' ? sessionId : null;
    if (recordingActive) startFrameCapture();
    else stopFrameCapture();
    ui.recordingChip.hidden = !recordingActive;
    ui.recordingNotice.hidden = !recordingActive;
    if (recordingActive) {
      reportMediaSources();
      if (!wasRecording) resetCaptions();
      ui.captionStatus.textContent = 'Listening; recognised speech appears after short audio segments.';
      ui.recordingNotice.textContent = 'Lifelogging active: live camera video is sent to your desktop, with audio transcription and periodic still images archived.';
    } else {
      ui.captionStatus.textContent = 'Transcription is off. Earlier captions remain until the next call.';
    }
    updateDisplay();
  }

  function configureIceServers(message) {
    const source = message.ice_servers ?? message.iceServers ?? message.stun ?? message.stun_servers;
    if (source == null) return;
    const normalize = item => {
      if (typeof item === 'string' && /^(stun|stuns|turn|turns):/i.test(item)) return { urls: item };
      if (item && typeof item === 'object' && (typeof item.urls === 'string' || (Array.isArray(item.urls) && item.urls.every(u => typeof u === 'string')))) return item;
      return null;
    };
    const list = (Array.isArray(source) ? source : [source]).map(normalize).filter(Boolean);
    // Honor an explicit empty list, for peers that can connect without STUN.
    if (Array.isArray(source) || list.length) iceServers = list;
  }

  async function signalingAddress() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const localAddress = `${protocol}//${location.host}/ws`;
    // A permanent app origin uses this public address book to discover the
    // current gateway after a temporary tunnel rotates. No pairing key lives
    // in endpoint.json, and the phone's localStorage survives every rotation.
    if (!location.hostname.endsWith('.github.io')) return localAddress;
    const checkedAddress = value => {
      const address = new URL(value);
      if (address.protocol !== 'wss:' || address.username || address.password || address.search || address.hash ||
          address.pathname !== '/ws' || !address.hostname.endsWith('.trycloudflare.com')) {
        throw new Error('The published calling address is invalid.');
      }
      return address.href;
    };
    // GitHub Pages may publish a changed endpoint several minutes after the
    // repository has already received it. After a failed socket connection,
    // read the same public JSON straight from GitHub until Pages catches up.
    if (endpointRefreshMode) {
      if (!githubEndpointCheckedAt || Date.now() - githubEndpointCheckedAt > 60000) {
        githubEndpointCheckedAt = Date.now();
        try {
          const url = 'https://api.github.com/repos/AchillesArte/caliban-direct-call/contents/endpoint.json?ref=main';
          const response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
          if (!response.ok) throw new Error('Endpoint repository unavailable');
          const payload = await response.json();
          const json = JSON.parse(atob(String(payload.content || '').replace(/\s+/g, '')));
          githubSignalUrl = checkedAddress(json.signal_url);
        } catch (error) {
          console.warn('Caliban live address lookup failed; using published address', error);
          githubSignalUrl = '';
        }
      }
      if (githubSignalUrl) return githubSignalUrl;
    }
    const url = new URL(`./endpoint.json?refresh=${Date.now()}`, location.href);
    const response = await fetch(url, {cache: 'no-store', credentials: 'omit'});
    if (!response.ok) throw new Error('The desktop address book is unavailable. Retry when it is online.');
    const data = await response.json();
    return checkedAddress(data.signal_url);
  }

  async function connect() {
    if (!token || resolvingEndpoint || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (!window.isSecureContext) {
      displayError('Camera and microphone access requires HTTPS. Open the secure pairing link supplied by Caliban.');
      status('HTTPS required', 'error');
      return;
    }
    resetPresence();
    let address;
    const pairingAtStart = token;
    resolvingEndpoint = true;
    try { address = await signalingAddress(); }
    catch (error) {
      displayError(error.message);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(connect, Math.min(15000, 700 * (2 ** Math.min(reconnectAttempts, 5))));
      return;
    } finally {
      resolvingEndpoint = false;
    }
    if (!token || token !== pairingAtStart ||
        (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
    const connection = new WebSocket(address);
    ws = connection;

    connection.addEventListener('open', () => {
      if (ws !== connection) return;
      reconnectAttempts = 0;
      try { connection.send(JSON.stringify({ type: 'hello', role: 'phone', token })); }
      catch (error) { displayError(`Pairing handshake failed: ${error.message}`); connection.close(); }
    });
    connection.addEventListener('message', event => {
      if (ws !== connection) return;
      try {
        const message = JSON.parse(event.data);
        Promise.resolve(handleMessage(message)).catch(error => {
          console.error('Caliban signalling error', error);
          displayError(`Call signalling failed: ${error.message}`);
          if (callPhase !== 'idle') endCall(true);
        });
      } catch (_) { displayError('The desktop sent an invalid signalling message.'); }
    });
    connection.addEventListener('error', () => {
      if (ws === connection) displayError('Could not reach the Caliban signalling service. Check the HTTPS connection.');
    });
    connection.addEventListener('close', event => {
      if (ws !== connection) return;
      ws = null;
      resetPresence();
      if (callPhase !== 'idle') {
        endCall(false);
        displayError('The connection to Caliban was interrupted. The call has ended.');
      }
      // An invalid token is not remedied by reconnection.
      if (event.code === 4001 || event.code === 4003 || event.code === 1008) {
        displayError('Pairing was rejected. Enter a current pairing key from your desktop.');
        token = '';
        forgetToken();
        updateDisplay();
      } else if (event.code === 4009) {
        // A second authorized Caliban window replaced this idle connection.
        // Retain its pairing and reconnect when this app returns to view.
        displayError('Caliban is open in another window. Return here to reconnect.');
      } else if (token) {
        endpointRefreshMode = true;
        reconnectAttempts += 1;
        const delay = Math.min(15000, 700 * (2 ** Math.min(reconnectAttempts, 5)));
        reconnectTimer = setTimeout(connect, delay);
      }
    });
  }

  async function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'welcome': {
        socketReady = true;
        configureIceServers(message);
        setDesktopOnline(message.desktop_online ?? message.presence?.desktop_online ?? false);
        if (typeof message.recording === 'boolean') setRecording(message.recording);
        else if (message.recording && typeof message.recording.active === 'boolean') setRecording(message.recording.active);
        displayError('');
        break;
      }
      case 'presence': {
        setDesktopOnline(message.desktop_online ?? message.online ?? false);
        if (typeof message.recording === 'boolean') setRecording(message.recording);
        break;
      }
      case 'record_request': {
        // The owner has given standing consent for personal paired-device calls.
        // Only an authenticated desktop can request this through the gateway.
        // Reject recording requests outside an active call.
        const accepted = callPhase !== 'idle';
        send({ type: 'record_consent', consent: accepted });
        updateDisplay();
        break;
      }
      case 'recording': {
        setRecording(message.active ?? message.recording ?? false, message.session_id);
        break;
      }
      case 'transcription_status': {
        if (recordingActive && recordingSessionId && message.session_id &&
            message.session_id !== recordingSessionId) break;
        if (typeof message.message === 'string') ui.captionStatus.textContent = message.message;
        break;
      }
      case 'transcript': {
        appendCaption(message);
        break;
      }
      case 'accept': {
        if (callPhase !== 'ringing') return;
        if (ringTimer) { clearTimeout(ringTimer); ringTimer = null; }
        callPhase = 'negotiating';
        updateDisplay();
        const connection = makePeer();
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        if (!send({ type: 'offer', sdp: connection.localDescription.toJSON() })) {
          throw new Error('The desktop signalling connection closed before the offer could be sent.');
        }
        break;
      }
      case 'offer': {
        if (callPhase !== 'idle') return;
        if (!window.confirm('Your Caliban desktop requests a video call. Accept and share your camera and microphone?')) {
          send({ type: 'hangup' });
          return;
        }
        const incomingSession = ++sessionNumber;
        callPhase = 'preparing';
        updateDisplay();
        if (!await prepareMedia(incomingSession)) return;
        callPhase = 'negotiating';
        updateDisplay();
        const connection = makePeer();
        await connection.setRemoteDescription(new RTCSessionDescription(message.sdp));
        await applyPendingCandidates();
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        send({ type: 'answer', sdp: connection.localDescription.toJSON() });
        break;
      }
      case 'answer': {
        if (!peer || peer.signalingState !== 'have-local-offer') return;
        await peer.setRemoteDescription(new RTCSessionDescription(message.sdp));
        await applyPendingCandidates();
        break;
      }
      case 'candidate': {
        if (!Object.prototype.hasOwnProperty.call(message, 'candidate')) return;
        if (!peer || !peer.remoteDescription) {
          if (pendingCandidates.length < 256) pendingCandidates.push(message.candidate);
        } else {
          await addIceCandidate(message.candidate);
        }
        break;
      }
      case 'hangup': {
        if (callPhase !== 'idle') {
          endCall(false);
          displayError('The desktop ended the call.');
        }
        break;
      }
      case 'reject':
      case 'decline':
      case 'busy': {
        if (callPhase !== 'idle') endCall(false);
        displayError(message.reason || 'Your desktop could not answer this call.');
        break;
      }
      case 'error': {
        displayError(typeof message.error === 'string' ? message.error : (message.message || 'The desktop reported an error.'));
        if (callPhase !== 'idle') endCall(false);
        break;
      }
      default:
        break;
    }
  }

  async function prepareMedia(expectedSession) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('The browser cannot access your camera. Use Safari with an HTTPS address on an up-to-date iPhone.');
    }
    let stream;
    audioOnly = false;
    const glassesReady = glassesRequested && glassesTrack?.readyState === 'live';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        // A glasses video track already exists. Keep only the phone microphone
        // active, avoiding needless activation of the iPhone camera.
        video: glassesReady ? false : phoneVideoConstraints('user'),
      });
    } catch (error) {
      if (!['NotAllowedError', 'NotFoundError', 'NotReadableError', 'AbortError', 'OverconstrainedError'].includes(error.name)) throw error;
      // A missing or denied camera must not prevent a microphone-only call.
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      audioOnly = !glassesReady;
      if (!glassesReady) displayError('Camera access is unavailable. This call will continue with microphone audio only.');
    }
    if (expectedSession !== sessionNumber) {
      stream.getTracks().forEach(track => track.stop());
      return false;
    }
    localStream = stream;
    phoneMicTrack = stream.getAudioTracks()[0] || null;
    phoneCameraTrack = stream.getVideoTracks()[0] || null;
    microphoneMuted = false;
    cameraDisabled = false;
    cameraFacing = 'user';
    ui.localVideo.classList.remove('back-camera');
    ui.localVideo.srcObject = stream;
    ui.localVideo.play().catch(() => {});
    updateControls();
    updateDisplay();
    if (glassesRequested && glassesTrack) await scheduleGlassesSwitch(useGlassesTrack);
    return true;
  }

  function makePeer() {
    if (peer) return peer;
    if (!localStream) throw new Error('Camera or microphone permission was not granted.');
    const connection = new RTCPeerConnection({ iceServers });
    peer = connection;
    remoteStream = new MediaStream();
    ui.remoteVideo.srcObject = remoteStream;
    connection.onicecandidate = event => {
      if (connection !== peer) return;
      send({ type: 'candidate', candidate: event.candidate ? event.candidate.toJSON() : null });
    };
    connection.ontrack = event => {
      if (connection !== peer) return;
      if (event.streams && event.streams[0]) {
        ui.remoteVideo.srcObject = event.streams[0];
      } else if (!remoteStream.getTracks().includes(event.track)) {
        remoteStream.addTrack(event.track);
      }
      if (event.track.kind === 'video') {
        ui.remoteVideo.classList.add('visible');
        event.track.addEventListener('unmute', () => {
          if (connection === peer) ui.remoteVideo.classList.add('visible');
        });
        event.track.addEventListener('ended', () => {
          if (connection === peer) {
            ui.remoteVideo.classList.remove('visible');
          }
        });
      }
      playRemoteAudio();
    };
    connection.onconnectionstatechange = () => {
      if (connection !== peer) return;
      switch (connection.connectionState) {
        case 'connected':
          if (callPhase !== 'connected') {
            callPhase = 'connected';
            connectedAt = Date.now();
            startDurationTimer();
            displayError('');
          }
          updateDisplay();
          break;
        case 'failed':
          endCall(true);
          displayError('The peer connection failed. Try calling again or check both devices’ internet connection.');
          break;
        case 'disconnected':
          if (callPhase === 'connected') {
            ui.callDescription.textContent = 'The media connection is interrupted. Waiting for recovery…';
          }
          break;
      }
    };
    // The negotiated video transceiver carries a continuous camera feed.
    // Keep a sender even if no camera was available at call setup; the owner
    // can select the phone or Meta camera later using replaceTrack().
    if (phoneMicTrack) audioSender = connection.addTrack(phoneMicTrack, localStream);
    const selectedVideo = localStream.getVideoTracks().find(track => track.readyState === 'live');
    const options = {
      direction: 'sendonly',
      sendEncodings: [{maxBitrate:8_000_000, maxFramerate:GLASSES_VIDEO_FPS, scaleResolutionDownBy:1}],
      ...(selectedVideo ? {streams:[localStream]} : {}),
    };
    try {
      videoSender = connection.addTransceiver(selectedVideo || 'video', options).sender;
    } catch (_) {
      // Some Safari versions do not implement addTransceiver sendEncodings.
      delete options.sendEncodings;
      videoSender = connection.addTransceiver(selectedVideo || 'video', options).sender;
    }
    // Keep the 720p/30fps Meta feed unscaled when browser and link permit it.
    // Unsupported WebKit settings simply retain congestion-controlled defaults.
    try {
      const parameters = videoSender.getParameters();
      if (parameters.encodings?.length) {
        parameters.degradationPreference = 'maintain-resolution';
        parameters.encodings[0].maxBitrate = 8_000_000;
        parameters.encodings[0].maxFramerate = GLASSES_VIDEO_FPS;
        parameters.encodings[0].scaleResolutionDownBy = 1;
        void videoSender.setParameters(parameters).catch(() => {});
      }
    } catch (_) { /* Browser applies its default quality controls. */ }
    return connection;
  }

  function playRemoteAudio() {
    ui.remoteVideo.play().then(() => { ui.audioButton.hidden = true; }).catch(() => {
      if (callPhase !== 'idle') ui.audioButton.hidden = false;
    });
  }

  async function addIceCandidate(candidate) {
    try {
      await peer.addIceCandidate(candidate ? new RTCIceCandidate(candidate) : null);
    } catch (error) {
      // A candidate from a previously closed transport can arrive during teardown.
      if (peer && peer.signalingState !== 'closed') console.warn('Caliban ICE candidate failed', error);
    }
  }

  async function applyPendingCandidates() {
    const queued = pendingCandidates;
    pendingCandidates = [];
    for (const candidate of queued) {
      if (!peer) break;
      await addIceCandidate(candidate);
    }
  }

  async function callDesktop() {
    if (!socketReady || !desktopOnline || callPhase !== 'idle') return;
    displayError('');
    if (glassesRequested) prepareGlassesAudio();
    const currentSession = ++sessionNumber;
    callPhase = 'preparing';
    updateDisplay();
    try {
      if (!await prepareMedia(currentSession)) return;
      if (!socketReady || !desktopOnline || !send({ type: 'call' })) {
        throw new Error('The desktop went offline before the call could start.');
      }
      callPhase = 'ringing';
      updateDisplay();
      ringTimer = setTimeout(() => {
        if (currentSession === sessionNumber && callPhase === 'ringing') {
          endCall(true);
          displayError('The desktop did not answer within 45 seconds. Try again.');
        }
      }, 45000);
    } catch (error) {
      if (currentSession !== sessionNumber) return;
      endCall(false);
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        displayError('Camera or microphone access was denied. Permit both in Safari Settings, then call again.');
      } else if (error.name === 'NotFoundError') {
        displayError('No usable camera or microphone was found.');
      } else {
        displayError(error.message || 'Unable to start the call.');
      }
    }
  }

  function startDurationTimer() {
    clearInterval(durationTimer);
    ui.duration.hidden = false;
    const tick = () => {
      const seconds = Math.floor((Date.now() - connectedAt) / 1000);
      ui.duration.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    };
    tick();
    durationTimer = setInterval(tick, 1000);
  }

  function endCall(notifyRemote) {
    if (notifyRemote && callPhase !== 'idle') send({ type: 'hangup' });
    setRecording(false);
    sessionNumber += 1;
    clearTimeout(ringTimer);
    clearInterval(durationTimer);
    ringTimer = null;
    durationTimer = null;
    if (peer) {
      peer.onconnectionstatechange = null;
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.close();
    }
    peer = null;
    videoSender = null;
    audioSender = null;
    phoneMicTrack = null;
    stopGlassesAudio();
    pendingCandidates = [];
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    phoneCameraTrack?.stop();
    phoneCameraTrack = null;
    glassesStream?.getTracks().forEach(track => track.stop());
    glassesStream = null;
    glassesTrack = null;
    glassesFrameRequester = null;
    glassesCanvas = null;
    glassesActive = false;
    ui.cameraSourceLabel.textContent = 'PHONE CAMERA';
    glassesRequested = false;
    glassesStatus = 'idle';
    postGlasses('stop');
    remoteStream = null;
    ui.remoteVideo.pause();
    ui.remoteVideo.srcObject = null;
    ui.remoteVideo.classList.remove('visible');
    ui.localVideo.srcObject = null;
    ui.audioButton.hidden = true;
    ui.duration.hidden = true;
    ui.duration.textContent = '00:00';
    cameraFacing = 'user';
    cameraDisabled = false;
    microphoneMuted = false;
    audioOnly = false;
    callPhase = 'idle';
    updateControls();
    updateDisplay();
    updateGlassesButton();
  }

  function updateControls() {
    ui.muteButton.setAttribute('aria-pressed', String(microphoneMuted));
    ui.videoButton.setAttribute('aria-pressed', String(cameraDisabled));
    ui.muteButton.lastElementChild.textContent = microphoneMuted ? 'Unmute' : 'Mute';
    ui.videoButton.lastElementChild.textContent = cameraDisabled ? 'Camera on' : 'Camera off';
  }

  function toggleMic() {
    if (!localStream) return;
    microphoneMuted = !microphoneMuted;
    localStream.getAudioTracks().forEach(track => { track.enabled = !microphoneMuted; });
    if (glassesAudioTrack) glassesAudioTrack.enabled = !microphoneMuted;
    updateControls();
  }

  function toggleCamera() {
    if (!localStream) return;
    cameraDisabled = !cameraDisabled;
    localStream.getVideoTracks().forEach(track => { track.enabled = !cameraDisabled; });
    updateControls();
    updateDisplay();
  }

  async function flipCamera() {
    if (!localStream || glassesRequested || cameraDisabled || ui.flipButton.disabled) return;
    ui.flipButton.disabled = true;
    const nextFacing = cameraFacing === 'user' ? 'environment' : 'user';
    const previous = localStream.getVideoTracks()[0];
    if (!previous) return;
    // Mobile Safari often cannot open the second camera before releasing the first.
    previous.stop();
    let replacement = null;
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({ video: phoneVideoConstraints(nextFacing), audio: false });
      replacement = videoStream.getVideoTracks()[0];
      if (!replacement) throw new Error('No video track returned');
      if (!localStream || callPhase === 'idle') { replacement.stop(); return; }
      if (videoSender) await videoSender.replaceTrack(replacement);
      if (!localStream || callPhase === 'idle') { replacement.stop(); return; }
      localStream.removeTrack(previous);
      localStream.addTrack(replacement);
      phoneCameraTrack = replacement;
      cameraFacing = nextFacing;
      ui.localVideo.classList.toggle('back-camera', cameraFacing === 'environment');
      ui.localVideo.srcObject = localStream;
      ui.localVideo.play().catch(() => {});
    } catch (error) {
      replacement?.stop();
      displayError(`Camera switch failed: ${error.message}. Tap Camera to retry if the video stopped.`);
      // Restore a usable camera when switching fails after Safari releases it.
      try {
        const restored = await navigator.mediaDevices.getUserMedia({ video: phoneVideoConstraints(cameraFacing), audio: false });
        const replacement = restored.getVideoTracks()[0];
        if (localStream && callPhase !== 'idle') {
          if (videoSender) await videoSender.replaceTrack(replacement);
          localStream.removeTrack(previous);
          localStream.addTrack(replacement);
          phoneCameraTrack = replacement;
          ui.localVideo.srcObject = localStream;
          ui.localVideo.play().catch(() => {});
        } else replacement.stop();
      } catch (_) { /* Leave microphone active; explain the camera failure. */ }
    } finally {
      updateDisplay();
    }
  }

  ui.pairForm.addEventListener('submit', event => {
    event.preventDefault();
    const proposed = cleanToken(ui.pairToken.value);
    if (!TOKEN_PATTERN.test(proposed)) {
      displayError('Enter the exact 64-character hexadecimal pairing key from Caliban.');
      return;
    }
    token = proposed;
    saveToken(token);
    displayError('');
    updateDisplay();
    connect();
  });
  ui.unpairButton.addEventListener('click', () => {
    endCall(true);
    if (ws) { const current = ws; ws = null; current.close(); }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    token = '';
    forgetToken();
    setRecording(false);
    resetPresence();
    displayError('');
    updateDisplay();
    ui.pairToken.value = '';
    ui.pairToken.focus();
  });
  ui.callButton.addEventListener('click', callDesktop);
  ui.hangupButton.addEventListener('click', () => { endCall(true); displayError(''); });
  ui.muteButton.addEventListener('click', toggleMic);
  ui.videoButton.addEventListener('click', toggleCamera);
  ui.flipButton.addEventListener('click', flipCamera);
  ui.audioButton.addEventListener('click', playRemoteAudio);
  ui.copyCaptions.addEventListener('click', () => {
    if (captions.length && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(captions.join('\n')).catch(() => displayError('The browser could not copy captions.'));
    }
  });
  ui.remoteVideo.addEventListener('loadedmetadata', () => { if (callPhase !== 'idle') playRemoteAudio(); });
  ui.localVideo.addEventListener('loadeddata', updateDisplay);
  ui.localVideo.addEventListener('playing', updateDisplay);
  window.addEventListener('online', () => { if (token) connect(); });
  window.addEventListener('offline', () => { status('Offline'); });
  function resumeConnection() {
    if (!token || document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - lastResumeAt < 1500) return;
    lastResumeAt = now;
    const suspended = hiddenAt && now - hiddenAt >= 12000;
    hiddenAt = 0;
    // iOS sometimes retains a WebSocket marked OPEN after suspending the
    // Home Screen app. Recreate idle signalling when returning to the app.
    // Never interrupt an active call merely for a focus event.
    if (!suspended && socketReady) return;
    if (callPhase !== 'idle' && socketReady) return;
    if (ws) {
      const old = ws;
      ws = null;
      old.close();
    }
    socketReady = false;
    connect();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else resumeConnection();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) resumeConnection();
  });
  window.addEventListener('focus', resumeConnection);
  window.addEventListener('beforeunload', () => {
    if (callPhase !== 'idle') send({ type: 'hangup' });
    if (localStream) localStream.getTracks().forEach(track => track.stop());
  });

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    ui.installButton.hidden = false;
  });
  ui.installButton.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
    } else ui.installHelp.hidden = !ui.installHelp.hidden;
  });
  window.addEventListener('appinstalled', () => { ui.installButton.hidden = true; ui.installHelp.hidden = true; });
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) {
    ui.installButton.hidden = true;
  }

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {}));
  }

  const fragmentToken = tokenFromFragment();
  token = fragmentToken || cleanToken(pairedTokenFromStorage());
  if (fragmentToken) saveToken(fragmentToken);
  if (token && !TOKEN_PATTERN.test(token)) { token = ''; forgetToken(); }
  updateControls();
  updateDisplay();
  if (token) connect();
})();
