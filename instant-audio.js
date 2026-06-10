/**
 * Instant Audio - TurboWarp Extension (Mastering Edition)
 * Extension Mode: Unsandboxed Only
 * Block Color: Red-Violet (#B31B4D)
 */

(function(Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('Instant Audio must be run unsandboxed.');
  }

  class InstantAudio {
    constructor() {
      this.audioContext = null;
      this.stream = null;
      this.source = null;
      this.analyser = null;
      this.isMonitoring = false;
      this.hasPermission = false;

      this.volumeSetting = 80;        
      this.masteringEnabled = true; // Toggles the EQ, Compressor, and Limiter
      
      this.selectedSampleRate = 'default';
      this.supportedRates = this.probeHardwareSampleRates();
    }

    probeHardwareSampleRates() {
      const standardRates = [44100, 48000, 88200, 96000, 192000];
      const verifiedRates = [{ text: 'Default (Hardware Native)', value: 'default' }];
      
      for (const rate of standardRates) {
        try {
          const testContext = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, rate);
          if (testContext) {
            verifiedRates.push({ text: `${rate / 1000} kHz`, value: String(rate) });
          }
        } catch (e) {}
      }
      return verifiedRates;
    }

    getInfo() {
      return {
        id: 'instantAudio',
        name: 'Instant Audio',
        color1: '#B31B4D', 
        color2: '#8C1139', 
        
        blocks: [
          {
            opcode: 'requestPermission',
            blockType: Scratch.BlockType.COMMAND,
            text: 'request audio input access'
          },
          {
            opcode: 'setSampleRate',
            blockType: Scratch.BlockType.COMMAND,
            text: 'set recording sample rate to [RATE]',
            arguments: {
              RATE: {
                type: Scratch.ArgumentType.STRING,
                menu: 'SAMPLE_RATES',
                defaultValue: 'default'
              }
            }
          },
          {
            opcode: 'startRecording',
            blockType: Scratch.BlockType.COMMAND,
            text: 'start recording'
          },
          {
            opcode: 'stopRecording',
            blockType: Scratch.BlockType.COMMAND,
            text: 'stop recording'
          },
          {
            opcode: 'getAudioMoment',
            blockType: Scratch.BlockType.REPORTER,
            text: 'get audio input at that moment'
          },
          {
            opcode: 'playAudioMoment',
            blockType: Scratch.BlockType.COMMAND,
            text: 'play sound bits [DATA]',
            arguments: {
              DATA: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: ''
              }
            }
          },
          {
            opcode: 'setPlaybackVolume',
            blockType: Scratch.BlockType.COMMAND,
            text: 'set playback volume to [VOL]%',
            arguments: {
              VOL: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: 80
              }
            }
          },
          {
            opcode: 'toggleMastering',
            blockType: Scratch.BlockType.COMMAND,
            text: 'set studio mastering [STATUS]',
            arguments: {
              STATUS: {
                type: Scratch.ArgumentType.STRING,
                menu: 'TOGGLE_MENU'
              }
            }
          },
          {
            opcode: 'checkPermissionStatus',
            blockType: Scratch.BlockType.BOOLEAN,
            text: 'audio input access granted?'
          },
          {
            opcode: 'checkRecordingStatus',
            blockType: Scratch.BlockType.BOOLEAN,
            text: 'recording enabled?'
          }
        ],
        menus: {
          TOGGLE_MENU: { acceptReporters: false, items: ['on', 'off'] },
          SAMPLE_RATES: { acceptReporters: false, items: 'getSampleRateMenu' }
        }
      };
    }

    getSampleRateMenu() { return this.supportedRates; }

    setSampleRate(args) {
      this.selectedSampleRate = args.RATE;
      if (this.hasPermission && this.audioContext) {
        const wasMonitoring = this.isMonitoring;
        if (wasMonitoring) this.stopRecording();
        this.audioContext.close().then(() => {
          const contextOptions = { latencyHint: 'interactive' };
          if (this.selectedSampleRate !== 'default') contextOptions.sampleRate = parseInt(this.selectedSampleRate, 10);
          this.audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
          if (wasMonitoring) this.startRecording();
        });
      }
    }

    requestPermission() {
      const constraints = {
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0 }
      };
      if (this.selectedSampleRate !== 'default') {
        constraints.audio.sampleRate = { ideal: parseInt(this.selectedSampleRate, 10) };
      } else {
        constraints.audio.sampleRate = { ideal: 96000 };
      }
      return navigator.mediaDevices.getUserMedia(constraints)
        .then(stream => {
          this.stream = stream;
          const contextOptions = { latencyHint: 'interactive' };
          if (this.selectedSampleRate !== 'default') contextOptions.sampleRate = parseInt(this.selectedSampleRate, 10);
          this.audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
          this.hasPermission = true; 
        })
        .catch(err => {
          console.error('Access denied:', err);
          this.hasPermission = false;
        });
    }

    startRecording() {
      if (!this.stream || !this.audioContext) return;
      if (this.audioContext.state === 'suspended') this.audioContext.resume();

      this.source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 16384; 
      
      this.source.connect(this.analyser);
      const dummyGain = this.audioContext.createGain();
      dummyGain.gain.setValueAtTime(0, this.audioContext.currentTime);
      this.analyser.connect(dummyGain);
      dummyGain.connect(this.audioContext.destination);

      this.isMonitoring = true;
    }

    stopRecording() {
      if (this.source) { this.source.disconnect(); this.source = null; }
      this.analyser = null;
      this.isMonitoring = false;
    }

    getAudioMoment() {
      if (!this.isMonitoring || !this.analyser) return "";

      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Float32Array(bufferLength);
      this.analyser.getFloatTimeDomainData(dataArray);

      // --- NEW: Hardware-level Noise Gate ---
      // Scans the array for the loudest peak. If the loudest sound is extremely quiet 
      // (likely just room hiss), zero out the entire array to record pure silence.
      let maxAmplitude = 0;
      for (let i = 0; i < dataArray.length; i++) {
        if (Math.abs(dataArray[i]) > maxAmplitude) maxAmplitude = Math.abs(dataArray[i]);
      }
      if (maxAmplitude < 0.008) { // 0.8% threshold
        dataArray.fill(0); 
      }

      const bytes = new Uint8Array(dataArray.buffer);
      let binaryStr = '';
      for (let i = 0; i < bytes.byteLength; i++) { binaryStr += String.fromCharCode(bytes[i]); }
      
      return this.audioContext.sampleRate + "|" + btoa(binaryStr);
    }

    async playAudioMoment(args) {
      if (!args.DATA || !this.audioContext) return;
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();

      try {
        const [rate, base64] = args.DATA.split('|');
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) { bytes[i] = binaryStr.charCodeAt(i); }

        const floatArray = new Float32Array(bytes.buffer);
        const fadeSize = 128; 
        if (floatArray.length > fadeSize * 2) {
          for (let i = 0; i < fadeSize; i++) {
            const ramp = i / fadeSize;
            floatArray[i] *= ramp;
            floatArray[floatArray.length - 1 - i] *= ramp;
          }
        }

        const audioBuffer = this.audioContext.createBuffer(1, floatArray.length, parseInt(rate));
        audioBuffer.copyToChannel(floatArray, 0);

        const sourceNode = this.audioContext.createBufferSource();
        sourceNode.buffer = audioBuffer;

        let lastNode = sourceNode;

        if (this.masteringEnabled) {
          // 1. Broadcast EQ: High Pass (remove sub rumble)
          const highPass = this.audioContext.createBiquadFilter();
          highPass.type = 'highpass';
          highPass.frequency.setValueAtTime(60, this.audioContext.currentTime);

          // 2. Broadcast EQ: Low Shelf (adds warmth/bass)
          const lowShelf = this.audioContext.createBiquadFilter();
          lowShelf.type = 'lowshelf';
          lowShelf.frequency.setValueAtTime(150, this.audioContext.currentTime);
          lowShelf.gain.setValueAtTime(2.5, this.audioContext.currentTime);

          // 3. Broadcast EQ: Mid Cut (removes muddy/boxy sound)
          const midCut = this.audioContext.createBiquadFilter();
          midCut.type = 'peaking';
          midCut.frequency.setValueAtTime(400, this.audioContext.currentTime);
          midCut.Q.setValueAtTime(0.7, this.audioContext.currentTime);
          midCut.gain.setValueAtTime(-2, this.audioContext.currentTime);

          // 4. Broadcast EQ: High Shelf (adds crisp presence)
          const highShelf = this.audioContext.createBiquadFilter();
          highShelf.type = 'highshelf';
          highShelf.frequency.setValueAtTime(4000, this.audioContext.currentTime);
          highShelf.gain.setValueAtTime(3.5, this.audioContext.currentTime);

          // 5. Studio Compressor (Levels out dynamics)
          const compressor = this.audioContext.createDynamicsCompressor();
          compressor.threshold.setValueAtTime(-20, this.audioContext.currentTime);
          compressor.knee.setValueAtTime(10, this.audioContext.currentTime);
          compressor.ratio.setValueAtTime(4, this.audioContext.currentTime); 
          compressor.attack.setValueAtTime(0.002, this.audioContext.currentTime);
          compressor.release.setValueAtTime(0.1, this.audioContext.currentTime);

          // 6. Brickwall Limiter (Prevents all digital clipping/distortion)
          const limiter = this.audioContext.createDynamicsCompressor();
          limiter.threshold.setValueAtTime(-1.5, this.audioContext.currentTime);
          limiter.knee.setValueAtTime(0, this.audioContext.currentTime); // Hard knee
          limiter.ratio.setValueAtTime(20, this.audioContext.currentTime); // Extreme ratio acts as a wall
          limiter.attack.setValueAtTime(0.001, this.audioContext.currentTime);
          limiter.release.setValueAtTime(0.05, this.audioContext.currentTime);

          // Connect the mastering chain
          lastNode.connect(highPass);
          highPass.connect(lowShelf);
          lowShelf.connect(midCut);
          midCut.connect(highShelf);
          highShelf.connect(compressor);
          compressor.connect(limiter);
          lastNode = limiter;
        }

        const gainNode = this.audioContext.createGain();
        const targetGain = Math.max(0, Math.min(200, this.volumeSetting)) / 100; 
        gainNode.gain.setValueAtTime(targetGain, this.audioContext.currentTime);

        lastNode.connect(gainNode);
        gainNode.connect(this.audioContext.destination);

        sourceNode.start();
      } catch (e) { console.error("Playback error:", e); }
    }

    setPlaybackVolume(args) {
      const vol = Number(args.VOL);
      if (!isNaN(vol)) this.volumeSetting = vol;
    }

    toggleMastering(args) { this.masteringEnabled = (args.STATUS === 'on'); }
    checkPermissionStatus() { return this.hasPermission; }
    checkRecordingStatus() { return this.isMonitoring; }
  }

  Scratch.extensions.register(new InstantAudio());
})(Scratch);