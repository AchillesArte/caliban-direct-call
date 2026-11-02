/* Caliban phone client: direct, paired WebRTC media via a trusted gateway. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const TOKEN_KEY = 'caliban.phone.pairing.v1';
  const TOKEN_PATTERN = /^[a-fA-F0-9]{64}$/;
  const WEBSOCKET_OPEN = 1;

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
  // This paired phone is the owner's personal lifelog device. Recording
  // requests originate from the paired desktop and are accepted for a call
  // without prompting again. An active recording remains plainly indicated.
  let recordingConsent = false;
  let socketReady = false;
  let connectedAt = 0;
  let callPhase = 'idle'; // idle | preparing | ringing | negotiating | connected
  let cameraFacing = 'user';
  let microphoneMuted = false;
  let cameraDisabled = false;
  let audioOnly = false;
  let peer = null;
  let localStream = null;
  let remoteStream = null;
  // The Meta DAT SDK runs in the native iOS wrapper. Safari cannot see its
  // camera as a getUserMedia device; native JPEGs are drawn into this track.
  const nativeGlasses = window.webkit?.messageHandlers?.calibanGlasses;
  let glassesRequested = false;
  let glassesActive = false;
  let glassesCanvas = null;
  let glassesStream = null;
  let glassesTrack = null;
  let phoneCameraTrack = null;
  let glassesFrameBusy = false;
  let glassesFrameLastAt = 0;
  let glassesStatus = 'idle';
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
    ui.glassesStatus.textContent = 'Meta glasses video requires the native Caliban iPhone app. Safari and Home Screen web apps cannot access the Meta Wearables camera SDK.';
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
    ui.glassesButton.textContent = glassesRequested ? 'Use iPhone camera' : 'Use Meta glasses camera';
    ui.glassesButton.disabled = glassesStatus === 'connecting';
    ui.flipButton.disabled = glassesRequested || !localStream || cameraDisabled || localStream.getVideoTracks().length === 0;
  }

  function scheduleGlassesSwitch(fn) {
    glassesSwitching = glassesSwitching.catch(() => {}).then(fn).catch(error => {
      glassesInfo(`Camera source change failed: ${error.message}`);
      displayError(`Could not switch camera: ${error.message}`);
    });
    return glassesSwitching;
  }

  async function useGlassesTrack() {
    if (!glassesRequested || !glassesTrack || !localStream || callPhase === 'idle' || glassesActive) return;
    const existing = localStream.getVideoTracks()[0] || null;
    if (existing && existing !== glassesTrack && existing !== phoneCameraTrack && existing.readyState === 'live') {
      existing.stop();
    }
    const sender = peer?.getSenders().find(s => s.track?.kind === 'video') ||
      peer?.getTransceivers().find(t => t.receiver?.track?.kind === 'video')?.sender;
    if (sender) await sender.replaceTrack(glassesTrack);
    if (existing && existing !== glassesTrack) localStream.removeTrack(existing);
    if (!localStream.getTracks().includes(glassesTrack)) localStream.addTrack(glassesTrack);
    glassesTrack.enabled = !cameraDisabled;
    ui.localVideo.srcObject = localStream;
    ui.localVideo.classList.add('back-camera');
    void ui.localVideo.play().catch(() => {});
    glassesActive = true;
    glassesInfo('Meta glasses camera is sending video to Caliban. Your iPhone microphone remains active.');
    updateDisplay();
  }

  async function usePhoneTrack() {
    if (!glassesActive || !localStream) { glassesActive = false; return; }
    let replacement = phoneCameraTrack?.readyState === 'live' ? phoneCameraTrack : null;
    if (!replacement) {
      try {
        const phone = await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:cameraFacing}}});
        replacement = phone.getVideoTracks()[0];
        phoneCameraTrack = replacement;
      } catch (error) { glassesInfo(`Phone camera unavailable: ${error.message}`); }
    }
    const sender = peer?.getSenders().find(s => s.track === glassesTrack) ||
      peer?.getTransceivers().find(t => t.sender?.track === glassesTrack)?.sender;
    if (sender) await sender.replaceTrack(replacement);
    if (glassesTrack && localStream.getTracks().includes(glassesTrack)) localStream.removeTrack(glassesTrack);
    if (replacement && !localStream.getTracks().includes(replacement)) localStream.addTrack(replacement);
    glassesActive = false;
    ui.localVideo.srcObject = localStream;
    ui.localVideo.classList.toggle('back-camera', cameraFacing === 'environment');
    void ui.localVideo.play().catch(() => {});
    updateDisplay();
  }

  async function disableGlasses() {
    glassesRequested = false;
    glassesStatus = 'idle';
    updateGlassesButton();
    postGlasses('stop');
    await scheduleGlassesSwitch(usePhoneTrack);
    glassesInfo('Using the iPhone camera.');
  }

  // This bridge exists only inside the native Caliban iOS app. Frames originate
  // in an explicit Meta SDK streaming session with Meta's camera permission.
  window.CalibanGlassesBridge = {
    onStatus(state, message) {
      if (!nativeGlasses) return;
      glassesStatus = ['connecting', 'streaming', 'idle', 'error'].includes(state) ? state : 'idle';
      if (glassesStatus === 'error' || (glassesStatus === 'idle' && glassesActive)) {
        if (glassesRequested) {
          glassesRequested = false;
          void scheduleGlassesSwitch(usePhoneTrack);
        }
      }
      glassesInfo(typeof message === 'string' && message ? message : `Meta glasses: ${glassesStatus}`);
      updateGlassesButton();
    },
    onFrame(base64Jpeg) {
      if (!nativeGlasses || !glassesRequested || typeof base64Jpeg !== 'string' ||
          base64Jpeg.length > 350000 || glassesFrameBusy) return;
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
            glassesStream = glassesCanvas.captureStream(15);
            glassesTrack = glassesStream.getVideoTracks()[0] || null;
            if (!glassesTrack) throw new Error('No video track could be created for the glasses.');
          }
          if (callPhase !== 'idle' && localStream && !glassesActive && !glassesSwitchQueued) {
            glassesSwitchQueued = true;
            void scheduleGlassesSwitch(useGlassesTrack).finally(() => { glassesSwitchQueued = false; });
          }
          else glassesInfo('Meta glasses camera ready. Start a call to send its view.');
        } catch (error) {
          glassesRequested = false;
          postGlasses('stop');
          glassesInfo(`Meta glasses unavailable: ${error.message}`);
          updateGlassesButton();
        } finally { glassesFrameBusy = false; }
      };
      frame.onerror = () => { glassesFrameBusy = false; glassesInfo('Could not decode a glasses video frame.'); };
      frame.src = `data:image/jpeg;base64,${base64Jpeg}`;
    },
  };

  ui.glassesButton.addEventListener('click', () => {
    if (!nativeGlasses) return;
    if (glassesRequested) { void disableGlasses(); return; }
    glassesRequested = true;
    glassesStatus = 'connecting';
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
    ui.localWrap.classList.toggle('show', Boolean(localStream && localStream.getVideoTracks().length));
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
      ui.stageMessage.textContent = audioOnly && callPhase === 'connected' ? 'Microphone connected. Your camera is unavailable.' : labels[callPhase];
      ui.stageCenter.classList.toggle('in-call', callPhase === 'connected' && ui.remoteVideo.classList.contains('visible'));
    } else {
      ui.stageCenter.classList.remove('in-call');
      ui.stageTitle.textContent = paired ? 'Your desktop is ready' : 'Your direct line';
      ui.stageMessage.textContent = paired
        ? (desktopOnline ? 'Start a call to speak face to face.' : 'Open Caliban Lifelog on your computer to connect.')
        : 'Connect securely to your Caliban desktop for a private video conversation.';
      ui.callDescription.textContent = socketReady
        ? (desktopOnline ? 'Your computer is online and available for a private call.' : 'Waiting for the Caliban desktop to connect.')
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

  function setRecording(active) {
    const wasRecording = recordingActive;
    recordingActive = active === true;
    ui.recordingChip.hidden = !recordingActive;
    ui.recordingNotice.hidden = !recordingActive;
    if (recordingActive) {
      if (!wasRecording) resetCaptions();
      ui.captionStatus.textContent = 'Listening; recognised speech appears after short audio segments.';
      ui.recordingNotice.textContent = 'Lifelogging active: audio transcription and video stills are saved to the desktop.';
    } else {
      ui.captionStatus.textContent = 'Transcription is off. Earlier captions remain until the next call.';
      recordingConsent = false;
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
        recordingConsent = accepted;
        send({ type: 'record_consent', consent: accepted });
        updateDisplay();
        break;
      }
      case 'recording': {
        setRecording(message.active ?? message.recording ?? false);
        break;
      }
      case 'transcription_status': {
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
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: 'user' },
      });
    } catch (error) {
      if (!['NotAllowedError', 'NotFoundError', 'NotReadableError', 'AbortError', 'OverconstrainedError'].includes(error.name)) throw error;
      // A missing or denied camera must not prevent a microphone-only call.
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      audioOnly = true;
      displayError('Camera access is unavailable. This call will continue with microphone audio only.');
    }
    if (expectedSession !== sessionNumber) {
      stream.getTracks().forEach(track => track.stop());
      return false;
    }
    localStream = stream;
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
        ui.stageCenter.classList.add('in-call');
        event.track.addEventListener('unmute', () => {
          if (connection === peer) ui.remoteVideo.classList.add('visible');
        });
        event.track.addEventListener('ended', () => {
          if (connection === peer) {
            ui.remoteVideo.classList.remove('visible');
            ui.stageCenter.classList.remove('in-call');
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
    localStream.getTracks().forEach(track => connection.addTrack(track, localStream));
    // Keep a negotiable video sender if the user starts in audio-only mode and
    // the glasses camera becomes available later during the same call.
    if (!localStream.getVideoTracks().length) connection.addTransceiver('video', {direction:'sendrecv'});
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
    recordingConsent = false;
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
    pendingCandidates = [];
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    phoneCameraTrack?.stop();
    phoneCameraTrack = null;
    glassesStream?.getTracks().forEach(track => track.stop());
    glassesStream = null;
    glassesTrack = null;
    glassesCanvas = null;
    glassesActive = false;
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
    recordingConsent = false;
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
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: nextFacing } }, audio: false });
      const replacement = videoStream.getVideoTracks()[0];
      if (!replacement) throw new Error('No video track returned');
      phoneCameraTrack = replacement;
      if (!localStream || callPhase === 'idle') { replacement.stop(); return; }
      localStream.removeTrack(previous);
      localStream.addTrack(replacement);
      const sender = peer && peer.getSenders().find(s => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(replacement);
      cameraFacing = nextFacing;
      ui.localVideo.classList.toggle('back-camera', cameraFacing === 'environment');
      ui.localVideo.srcObject = localStream;
      ui.localVideo.play().catch(() => {});
    } catch (error) {
      displayError(`Camera switch failed: ${error.message}. Tap Camera to retry if the video stopped.`);
      // Restore a usable camera when switching fails after Safari releases it.
      try {
        const restored = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: cameraFacing } }, audio: false });
        const replacement = restored.getVideoTracks()[0];
        phoneCameraTrack = replacement;
        if (localStream && callPhase !== 'idle') {
          localStream.removeTrack(previous);
          localStream.addTrack(replacement);
          const sender = peer && peer.getSenders().find(s => s.track?.kind === 'video');
          if (sender) await sender.replaceTrack(replacement);
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
