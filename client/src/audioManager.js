import { math } from "../../shared/utils/math";
import { util } from "../../shared/utils/util";
import { v2 } from "../../shared/utils/v2";
import createJS from "./createJS";
import soundDefs from "./soundDefs";

const AudioManagerMinAllowedVolume = 0.003;
const DiffLayerMult = 0.5;

export default class AudioManager {
    constructor(options) {
        this.mute = false;
        this.masterVolume = 1;
        this.soundVolume = 1;
        this.musicVolume = 1;
        this.baseVolume = 0.5;
        this.sounds = {};
        this.loadedFiles = {};
        this.preloadedSounds = false;
        this.cameraPos = v2.create(0, 0);
        this.activeLayer = 0;
        this.underground = false;
        this.soundInstances = [];
        createJS.Sound.volume = 0.5;
        createJS.Sound.on("fileload", this.loadHandler, this);
    }

    preloadSounds() {
        if (!this.preloadedSounds) {
            // Ideally sounds should only be defined once
            this.preloadedSounds = true;

            const preloadedSounds = {};
            const soundGroups = Object.keys(soundDefs.Sounds);
            for (
                let i = 0;
                i < soundGroups.length;
                i++
            ) {
                const soundGroup = soundGroups[i];
                const soundList = soundDefs.Sounds[soundGroup];
                const soundListKeys = Object.keys(soundList);

                for (
                    let j = 0;
                    j < soundListKeys.length;
                    j++
                ) {
                    const soundName = soundListKeys[j];
                    if (preloadedSounds[soundName] !== undefined) {
                        console.log(
                            `Sound ${soundName} defined multiple times!`
                        );
                    }
                    preloadedSounds[soundName] = true;
                }
            }
            const loadList = [];
            const channelKeys = Object.keys(soundDefs.Channels);
            for (
                let i = 0;
                i < channelKeys.length;
                i++
            ) {
                const channelKey = channelKeys[i];
                const channel = soundDefs.Channels[channelKey];
                const sounds = soundDefs.Sounds[channel.list];
                const soundKeys = Object.keys(sounds);
                for (
                    let j = 0;
                    j < soundKeys.length;
                    j++
                ) {
                    const key = soundKeys[j];
                    const sound = sounds[key];
                    if (sound.preload === undefined || sound.preload) {
                        const options = {
                            canCoalesce: sound.canCoalesce,
                            channels: sound.maxInstances,
                            volume: sound.volume
                        };
                        loadList.push({
                            name: key,
                            channel: channelKey,
                            path: sound.path,
                            options,
                            priority: sound.loadPriority || 0
                        });
                    }
                }
            }
            loadList.sort((a, b) => {
                return b.priority - a.priority;
            });
            for (let i = 0; i < loadList.length; i++) {
                const sound = loadList[i];
                this.loadSound(sound);
            }
            const reverbs = soundDefs.Reverbs;
            const reverbKeys = Object.keys(reverbs);

            for (
                let i = 0;
                i < reverbKeys.length;
                i++
            ) {
                const key = reverbKeys[i];
                const reverb = reverbs[key];
                createJS.Sound.registerReverb(reverb.path, key, reverb);
            }
        }
    }

    loadSound(sound) {
        const name = sound.name + sound.channel;
        if (!this.sounds[name]) {
            createJS.Sound.registerSound(sound.path, name, sound.options || {});
            this.sounds[name] = {
                path: sound.path,
                name: sound.name,
                channel: sound.channel
            };
        }
    }

    loadHandler(path) {
        this.loadedFiles[path] = true;
    }

    m(dt) {
        // Clear out finished sounds from stored instances
        for (let i = this.soundInstances.length - 1; i >= 0; i--) {
            const inst = this.soundInstances[i];
            if (
                inst.instance.playState == "playFinished" ||
                inst.instance.playState == "playInterrupted" ||
                inst.instance.playState == "playFailed"
            ) {
                this.soundInstances.splice(i, 1);
            }
        }

        // Update reverb, simply based on the current terrain layer
        const layerVolumeMap = [0, 1, 1 / 3, 2 / 3];
        const reverbVolume = this.underground ? layerVolumeMap[this.activeLayer] : 0;
        createJS.Sound.setReverbs({
            cathedral: reverbVolume
        });
        // Update the audio backend
        createJS.Sound.update(dt);
    }

    playSound(sound, options = {}) {
        if (!sound || sound == "none") {
            return null;
        }
        options.channel = options.channel || "activePlayer";
        options.startSilent = options.startSilent || false;
        options.forceStart = options.forceStart || false;
        options.loop = options.loop || false;
        options.soundPos = options.soundPos || null;
        options.fallOff = options.fallOff || 0;
        options.filter = options.filter || "";
        options.delay = options.delay || 0;
        options.ignoreMinAllowable = options.ignoreMinAllowable || false;
        options.rangeMult = options.rangeMult || 1;
        options.offset = options.offset || 0;
        options.ambient = options.channel == "ambient" || options.channel == "music";
        options.detune = options.detune || 0;
        options.volumeScale = options.volumeScale || 1;
        let instance = null;
        const a = soundDefs.Channels[options.channel];
        if (a && (!this.mute || options.forceStart)) {
            const baseVolume =
                this.baseVolume *
                1 *
                this.getTypeVolume(a.type) *
                options.volumeScale;
            const diffLayer =
                options.layer !== undefined &&
                !util.sameAudioLayer(options.layer, this.activeLayer);
            const filter = options.filter
                ? diffLayer || options.forceFilter
                    ? options.filter
                    : "reverb"
                : "none";
            if (options.channel != "activePlayer" && options.soundPos) {
                const diff = v2.sub(this.cameraPos, options.soundPos);
                const dist = v2.length(diff);
                let range = a.maxRange * options.rangeMult;
                if (math.eqAbs(range, 0)) {
                    range = 1;
                }
                const distNormal = math.clamp(Math.abs(dist / range), 0, 1);
                const scaledVolume = Math.pow(1 - distNormal, 1 + options.fallOff * 2);
                let clipVolume = a.volume * scaledVolume * baseVolume;
                clipVolume = diffLayer ? clipVolume * DiffLayerMult : clipVolume;

                // Play if this sound is above the accepted vol threshold
                if (
                    clipVolume > AudioManagerMinAllowedVolume ||
                    options.ignoreMinAllowable
                ) {
                    const stereoNorm = math.clamp((diff.x / range) * -1, -1, 1);
                    instance = createJS.Sound.play(sound + options.channel, {
                        filter,
                        loop: options.loop ? -1 : 0,
                        volume: options.startSilent ? 0 : clipVolume,
                        pan: stereoNorm,
                        delay: options.delay,
                        offset: options.offset,
                        ambient: options.ambient,
                        detune: options.detune
                    });
                }
            } else {
                let clipVolume = a.volume * baseVolume;
                clipVolume = diffLayer ? clipVolume * DiffLayerMult : clipVolume;
                instance = createJS.Sound.play(sound + options.channel, {
                    filter,
                    loop: options.loop ? -1 : 0,
                    volume: options.startSilent ? 0 : clipVolume,
                    delay: options.delay,
                    offset: options.offset,
                    ambient: options.ambient,
                    detune: options.detune
                });
            }
            // Add looped sounds and music to stored sounds
            if (instance && (options.loop || options.channel == "music")) {
                const type = options.channel == "music" ? "music" : "sound";
                this.soundInstances.push({
                    instance,
                    type
                });
            }
        }
        return instance;
    }

    playGroup(group, option = {}) {
        const _group = soundDefs.Groups[group];
        if (_group) {
            const a = _group.sounds;
            const i = Math.floor(util.random(0, a.length));
            option.channel = _group.channel;
            return this.playSound(a[i], option);
        }
        return null;
    }

    updateSound(instance, channel, soundPos, options = {}) {
        options.fallOff = options.fallOff || 0;
        options.rangeMult = options.rangeMult || 1;
        options.ignoreMinAllowable = options.ignoreMinAllowable || false;
        options.volumeScale = options.volumeScale || 1;
        const a = soundDefs.Channels[channel];
        if (instance && a) {
            const baseVolume =
                this.baseVolume *
                1 *
                this.getTypeVolume(a.type) *
                options.volumeScale;
            const diff = v2.sub(this.cameraPos, soundPos);
            const dist = v2.length(diff);
            let range = a.maxRange * options.rangeMult;
            if (math.eqAbs(range, 0)) {
                range = 1;
            }
            const distNormal = math.clamp(Math.abs(dist / range), 0, 1);
            const scaledVolume = Math.pow(1 - distNormal, 1 + options.fallOff * 2);
            let clipVolume = a.volume * scaledVolume * baseVolume;
            const diffLayer = options.layer === undefined ||
            util.sameAudioLayer(options.layer, this.activeLayer);
            clipVolume = diffLayer ? clipVolume : clipVolume * DiffLayerMult;
            if (
                clipVolume > AudioManagerMinAllowedVolume || options.ignoreMinAllowable
            ) {
                const stereoNorm = math.clamp((diff.x / range) * -1, -1, 1);
                instance.volume = clipVolume;
                instance.pan = stereoNorm;
            }
        }
    }

    setMasterVolume(volume) {
        volume = math.clamp(volume, 0, 1);
        createJS.Sound.volume = volume;
    }

    _setInstanceTypeVolume(type, volume) {
        volume = math.clamp(volume, 0, 1);
        const typeVolume = this.getTypeVolume(type);
        const scaledVolume = typeVolume > 0.0001 ? volume / typeVolume : 0;
        for (
            let i = 0;
            i < this.soundInstances.length;
            i++
        ) {
            const inst = this.soundInstances[i];
            if (inst.type == type) {
                inst.instance.volume *= scaledVolume;
            }
        }
    }

    setSoundVolume(volume) {
        this._setInstanceTypeVolume("sound", volume);
        this.soundVolume = volume;
    }

    setMusicVolume(volume) {
        this._setInstanceTypeVolume("music", volume);
        this.musicVolume = volume;
    }

    setVolume(instance, volume, type) {
        if (instance) {
            type = type || "sound";
            const typeVolume = this.getTypeVolume(type);
            instance.volume = volume * typeVolume;
        }
    }

    getVolume(instance) {
        if (instance) {
            return instance.volume;
        }
        return 0;
    }

    setMute(mute) {
        this.mute = mute;
        createJS.Sound.setMute(this.mute);
        return this.mute;
    }

    muteToggle() {
        return this.setMute(!this.mute);
    }

    setDelay(instance, duration) {
        if (instance) {
            instance.delay = duration;
        }
    }

    stopSound(instance) {
        instance?.stop();
    }

    stopAll() {
        createJS.Sound.stop();
    }

    allLoaded() {
        const keys = Object.keys(this.sounds);
        for (
            let i = 0;
            i < keys.length;
            i++
        ) {
            const sound = this.sounds[keys[i]];
            if (!this.isSoundLoaded(sound.name, sound.channel)) {
                return false;
            }
        }
        return true;
    }

    isSoundLoaded(soundName, key) {
        const sound = this.sounds[soundName + key];
        return sound && this.loadedFiles[sound.path];
    }

    isSoundPlaying(inst) {
        return !!inst && inst.playState == createJS.Sound.PLAY_SUCCEEDED;
    }

    getSoundDefVolume(sound, channel) {
        const soundDef = soundDefs.Sounds[channel][sound];
        const channelDef = soundDefs.Channels[channel];
        if (soundDef && channelDef) {
            return soundDef.volume * channelDef.volume;
        }
        return 1;
    }

    getTypeVolume(type) {
        switch (type) {
        case "music":
            return this.musicVolume;
        case "sound":
            return this.soundVolume    
        default:
            return this.soundVolume;
        }
    }
}
