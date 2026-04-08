#!/usr/bin/env node
'use strict';

const fs       = require('fs');
const path     = require('path');
const { parseMidi } = require('midi-file');
const { program }   = require('commander');


const banner = String.raw`
               __        __  __   ______   __        __       
              |  \      |  \|  \ /      \ |  \      |  \      
 ______ ____   \$$  ____| $$ \$$|  $$$$$$\| $$____  | $$____  
|      \    \ |  \ /      $$|  \ \$$__| $$| $$    \ | $$    \ 
| $$$$$$\$$$$\| $$|  $$$$$$$| $$ /      $$| $$$$$$$\| $$$$$$$\
| $$ | $$ | $$| $$| $$  | $$| $$|  $$$$$$ | $$  | $$| $$  | $$
| $$ | $$ | $$| $$| $$__| $$| $$| $$_____ | $$__/ $$| $$__/ $$
| $$ | $$ | $$| $$ \$$    $$| $$| $$     \| $$    $$| $$    $$
 \$$  \$$  \$$ \$$  \$$$$$$$ \$$ \$$$$$$$$ \$$$$$$$  \$$$$$$$ 
`;
// ─── CONSTANTES ──────────────────────────────────────────────────────────────

const DEFAULT_SR     = 8000;
const DEFAULT_TEMPO  = 500000;
const MAX_FILE_SIZE  = 10 * 1024 * 1024;
const DRUM_CH        = 9;
const RELEASE_TAIL   = 0; // samples extras de release após noteOff

// ─── ERRO ─────────────────────────────────────────────────────────────────────

class MidiError extends Error {
    constructor(msg, code) {
        super(msg);
        this.name = 'MidiError';
        this.code = code;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MODO FLOAT — DSP ENGINE
// Injetado via t?0:(...) — roda uma vez e define tudo como global no player
// ─────────────────────────────────────────────────────────────────────────────

function dspEngineHeader(sr) {
    // Cada bloco separado por comentário pra facilitar leitura do output gerado
    return [
        `_SR=${sr}`,
        `_TAU=Math.PI*2`,
        `_z=[]`, // array de estado de filtros (persistente entre samples)

        // ── Filtros one-pole IIR com estado isolado por id ───────────────────
        // id garante que cada chamada (de notas diferentes) não compartilha estado
        `_lp=(a,c,id)=>{return _z[id]=(_z[id]??0)+(a-(_z[id]??0))*c}`,
        `_hp=(a,c,id)=>a-_lp(a,c,id)`,
        `_bp=(a,lc,hc,id)=>_hp(_lp(a,lc,id),hc,id+500)`,
        `_nf=(a,lc,hc,id)=>(_lp(a,lc,id)+_hp(a,hc,id+500))/1.5`,
        `_lb=(a,c,v,id)=>a+_lp(a,c,id)*v`,  // low boost
        `_hb=(a,c,v,id)=>a+_hp(a,c,id)*v`,  // high boost

        // ── Osciladores básicos (retornam -1..1) ─────────────────────────────
        `_si=(f,t)=>Math.sin(t*f*_TAU/_SR)`,
        `_sa=(f,t)=>(t*f/_SR%1)*2-1`,
        `_sq=(f,t)=>(_sa(f,t)>0?1:-1)`,
        `_tr=(f,t)=>Math.abs(_sa(f,t)*2)-1`,
        `_pw=(f,t,d)=>(t*f/_SR%1<d?1:-1)`,
        `_ns=()=>Math.random()*2-1`,

        // ── FM: carrier modulado por seno (como DX7 simplificado) ─────────────
        // f=carrier freq, r=mod ratio, ix=index (depth), t=sample
        `_fm=(f,r,ix,t)=>Math.sin(t*f*_TAU/_SR+Math.sin(t*f*r*_TAU/_SR)*ix)`,

        // ── Chorus: dois oscs levemente desafinados ───────────────────────────
        `_ch=(f,t,dt)=>(_si(f,t)+_si(f*1.005,t+dt))*0.5`,

        // ── Envelope ADSR inteiro (age=amostras desde noteOn, dur=duração nota)
        // at=attack, dc=decay, su=sustain (0-1), re=release (em samples)
        `_env=(age,dur,at,dc,su,re)=>{` +
            `if(age<0)return 0;` +
            `if(age<at)return age/at;` +
            `if(age<at+dc)return 1-(1-su)*(age-at)/dc;` +
            `if(age<dur)return su;` +
            `var rd=age-dur;return rd>re?0:su*(1-rd/re)` +
        `}`,

        // ── Utilitários ───────────────────────────────────────────────────────
        `_tanh=Math.tanh`,
        `_abs=Math.abs`,
        `_exp=Math.exp`,
        `_sin=Math.sin`,
        `_cos=Math.cos`,
        `_pow=Math.pow`,
        `_clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x))`,
        `_lerp=(a,b,t)=>a+(b-a)*t`,
        `_dcy=(age,rate)=>Math.exp(-age*rate)`, // shorthand pra decay exponencial
    ].join(',');
}

// ─────────────────────────────────────────────────────────────────────────────
// PRESETS DE INSTRUMENTO (modo float)
//
// Assinatura: (age, dur, freq, vel, fb) → valor em ~[-1, 1]
//   age  = t - noteStart  (amostras desde ataque)
//   dur  = noteEnd - noteStart  (duração da nota em samples)
//   freq = Hz da nota MIDI
//   vel  = velocity MIDI 0-127
//   fb   = filter base index (i*20, isola estado de filtro por nota)
// ─────────────────────────────────────────────────────────────────────────────

const FLOAT_PRESETS = {

    // Piano de cauda — FM op2 + decaimento natural, sem sustain longo
    piano: `(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,25,180,0.25,350),
            ph=age*freq*_TAU/_SR,
            mod=_sin(ph*2.756)*_dcy(age,0.005)*4.2,
            s=_sin(ph+mod)*_dcy(age,0.0018);
        return _tanh(s*1.6)*e*(vel/127)
    }`,

    // Rhodes / E-Piano — vibrato tardio + FM suave
    epiano: `(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,8,280,0.18,280),
            ph=age*freq*_TAU/_SR,
            vib=1+_sin(age*6.5*_TAU/_SR)*_clamp(age/450,0,0.048),
            s=_sin(ph*vib+_sin(ph*1.89)*1.4*_dcy(age,0.003));
        return _tanh(s)*e*(vel/127)
    }`,

    // Órgão Hammond — síntese aditiva com 6 harmônicos (drawbars)
    organ: `(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,5,0,1,15),
            s=_si(freq,age)
             +_si(freq*2,age)*0.5
             +_si(freq*3,age)*0.33
             +_si(freq*4,age)*0.15
             +_si(freq*6,age)*0.1
             +_si(freq*8,age)*0.05;
        return _tanh(s*0.48)*e*(vel/127)
    }`,

    // Synth lead — saw+sq misturados + filtro LPF com abertura dinâmica
    lead: `(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,18,70,0.75,130),
            cut=_clamp(0.12+age*0.00007,0.08,0.9),
            s=_sq(freq,age)*0.55+_sa(freq,age)*0.45+_si(freq,age)*0.2;
        return _lp(_tanh(s*0.85),cut,fb)*e*(vel/127)
    }`,

    // Bass sintético — sines em camadas + LPF fechado
    bass: `(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,12,70,0.72,120),
            s=_si(freq,age)
             +_si(freq*2,age)*0.28
             +_si(freq*0.5,age)*0.38;
        return _lp(_tanh(s*2.2)*0.85,0.32,fb)*e*(vel/127)
    }`,

    // Sub-bass — só fundamentais bem filtrados
    subbass: `(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,18,90,0.88,180),
            s=_si(freq,age)*0.7+_si(freq*0.5,age)*0.55;
        return _tanh(_lp(s*2.8,0.18,fb))*e*(vel/127)
    }`,

    // Pad atmosférico — ataque lento + chorus + filtro
    pad: `(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,900,280,0.78,700),
            s=_sa(freq,age)*0.48
             +_si(freq*1.004,age)*0.38
             +_si(freq*2,age)*0.1
             +_ch(freq,age,48)*0.28;
        return _lp(_tanh(s),0.48,fb)*e*(vel/127)
    }`,

    // Cordas — vibrato crescente, attack médio
    strings: `(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,480,130,0.88,580),
            vib=_clamp((age-380)/280,0,1)*0.014,
            fv=freq*(1+_sin(age*5.5*_TAU/_SR)*vib),
            s=_sa(fv,age)*0.58+_sa(fv*2,age)*0.22+_si(fv,age)*0.18;
        return _lp(s,0.52,fb)*e*(vel/127)*0.88
    }`,

    // Metais — filter sweep agressivo no ataque
    brass: `(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,55,55,0.92,130),
            cut=_clamp(age/580+0.08,0.07,0.92),
            s=_sq(freq,age)+_sq(freq*2,age)*0.38+_sq(freq*3,age)*0.14;
        return _lp(_tanh(s*1.6),cut,fb)*e*(vel/127)
    }`,

    // Flauta — vibrato + breath noise sutil
    flute: `(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,110,55,0.92,160),
            vib=_clamp((age-230)/280,0,1)*0.017,
            fv=freq*(1+_sin(age*6.1*_TAU/_SR)*vib),
            s=_si(fv,age)+_si(fv*2,age)*0.09+_ns()*0.035;
        return _hp(_lp(s,0.88,fb),0.04,fb+1)*e*(vel/127)
    }`,

    // Pluck / guitarra — Karplus-ish (decaimento proporcional à freq)
    pluck: `(age,dur,freq,vel,fb)=>{
        var e=_dcy(age,freq/_SR*2.4),
            s=_si(freq,age)+_si(freq*2,age)*0.48+_si(freq*3,age)*0.22;
        return _lp(s,0.82,fb)*e*(vel/127)
    }`,

    // Sino — FM multi-op com decaimento longo
    bell: `(age,dur,freq,vel,fb)=>{
        var e=_dcy(age,0.00065),
            s=_fm(freq,3.5,6*_dcy(age,0.003),age)
             +_fm(freq,2.0,3*_dcy(age,0.002),age)*0.38
             +_fm(freq,5.0,2*_dcy(age,0.005),age)*0.14;
        return s*e*(vel/127)
    }`,

    // Vibrafone / Marimba — FM com tom limpo e percussivo
    marimba: `(age,dur,freq,vel,fb)=>{
        var e=_dcy(age,0.0033),
            s=_fm(freq,2.0,5.2*_dcy(age,0.011),age)
             +_si(freq,age)*0.22
             +_si(freq*4,age)*0.09;
        return _lp(s,0.88,fb)*e*(vel/127)
    }`,

    // Clavinet — pluck nasal, staccato
    clav: `(age,dur,freq,vel,fb)=>{
        var e=_dcy(age,freq/_SR*3.5)*_env(age,dur,5,0,0,50),
            s=_pw(freq,age,0.28)+_pw(freq*2,age,0.35)*0.3;
        return _hp(_tanh(s*1.4),0.12,fb)*e*(vel/127)
    }`,

    // Synth pluck tipo 303
    tb303: `(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,8,60,0.3,100),
            cut=_clamp(0.05+_dcy(age,0.003)*0.7,0.04,0.88),
            s=_sa(freq,age)+_sa(freq,age+1)*0.4; // ligeiro detune
        return _lp(_tanh(s*1.8),cut,fb)*e*(vel/127)
    }`,

    // ── Percussão ────────────────────────────────────────────────────────────

    // Bumbo — sine sweep descendente
    kick: `(age,dur,freq,vel,fb)=>{
        var e=_dcy(age,0.0038),
            pitch=(freq||80)*(1+_dcy(age,0.042)*7.5),
            s=_si(pitch,age)+_si(pitch*0.5,age)*0.2;
        return _tanh(s*e*5.5)*_dcy(age,0.0022)*(vel/127)
    }`,

    // Caixa — noise + tom
    snare: `(age,dur,freq,vel,fb)=>{
        var e=_dcy(age,0.0065),
            noise=_hp(_ns(),0.52,fb),
            tone=_si(freq||200,age)*0.32;
        return (noise*0.68+tone)*e*(vel/127)
    }`,

    // Hi-hat — noise highpass (dur<500 = fechado, senão aberto)
    hihat: `(age,dur,freq,vel,fb)=>{
        var e=_dcy(age,dur<500?0.048:0.0055),
            s=_hp(_ns(),0.94,fb)+_hp(_ns(),0.97,fb+1);
        return s*0.48*e*(vel/127)*0.38
    }`,

    // Palma sintética — noise bandpass em camadas
    clap: `(age,dur,freq,vel,fb)=>{
        var e=_dcy(age,0.014)+_dcy(_abs(age-85),0.019)*0.28,
            s=_bp(_ns(),0.28,0.9,fb);
        return s*e*(vel/127)*0.72
    }`,

    // Percussão genérica — noise BP + tom sintético
    perc: `(age,dur,freq,vel,fb)=>{
        var e=_dcy(age,0.013),
            s=_bp(_ns()+_si(freq||320,age)*0.22,0.2,0.8,fb);
        return _tanh(s*2.1)*e*(vel/127)
    }`,

    // Crash / Cymbal
    crash: `(age,dur,freq,vel,fb)=>{
        var e=_dcy(age,0.0008),
            s=_hp(_ns(),0.85,fb)+_hp(_ns()*_sq(freq||400,age),0.9,fb+1)*0.3;
        return s*e*(vel/127)*0.5
    }`,

    // Tom
    tom: `(age,dur,freq,vel,fb)=>{
        var e=_dcy(age,0.003),
            pitch=(freq||120)*(1+_dcy(age,0.025)*3),
            s=_si(pitch,age)+_ns()*0.15*_dcy(age,0.02);
        return _tanh(s*3)*e*(vel/127)
    }`,

    // Fallback genérico
    default: `(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,20,100,0.6,180),
            s=_sq(freq,age)*0.58+_sa(freq,age)*0.42;
        return _lp(s,0.5,fb)*e*(vel/127)
    }`,

    // Supersaw — 7 saws levemente desafinados, som gordo de trance
    supersaw: `(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,15,80,0.82,150),
            d=[0,0.006,-0.006,0.012,-0.012,0.018,-0.018],
            s=d.reduce((a,dt)=>a+_sa(freq*(1+dt),age),0)/5.2;
        return _lp(_tanh(s*1.4),0.75,fb)*e*(vel/127)
    }`,
};

// ─────────────────────────────────────────────────────────────────────────────
// MAPEAMENTOS GM (General MIDI)
// ─────────────────────────────────────────────────────────────────────────────

// Program (0-127) → preset name
const GM_PROG = (() => {
    const m = {};
    // 0-7 Piano
    [0,1].forEach(i=>m[i]='piano');
    [2,3,4,5,6,7].forEach(i=>m[i]='epiano');
    // 8-15 Chromatic perc
    [8,14,15].forEach(i=>m[i]='bell');
    [9,10,11,12,13].forEach(i=>m[i]='marimba');
    // 16-23 Organ
    for(let i=16;i<24;i++) m[i]='organ';
    // 24-31 Guitar
    [24,25,26,27,28,29,31].forEach(i=>m[i]='pluck');
    m[30]='lead';
    // 32-39 Bass
    [32,33,34,35,37,38,39].forEach(i=>m[i]='bass');
    m[36]='subbass';
    // 40-47 Strings
    for(let i=40;i<48;i++) m[i]='strings';
    // 48-55 Ensemble
    [48,49].forEach(i=>m[i]='strings');
    [50,51,52,53].forEach(i=>m[i]='pad');
    [54,55].forEach(i=>m[i]='brass');
    // 56-63 Brass
    for(let i=56;i<64;i++) m[i]='brass';
    // 64-79 Reed/Pipe
    for(let i=64;i<80;i++) m[i]=[67,68,69,70,71,72,73,74,75,76,77].includes(i)?'flute':'lead';
    // 80-87 Synth Lead
    for(let i=80;i<88;i++) m[i]='lead';
    // 88-95 Synth Pad
    for(let i=88;i<96;i++) m[i]='pad';
    // 96+
    for(let i=96;i<128;i++) m[i]=i<104?'bell':i<112?'pluck':i<120?'marimba':'perc';
    return m;
})();

// Nota de percussão GM (canal 9) → preset name
const GM_DRUM = {
    35:'kick', 36:'kick',
    37:'snare', 38:'snare', 40:'snare',
    39:'clap',
    41:'tom', 43:'tom', 45:'tom', 47:'tom', 48:'tom', 50:'tom',
    42:'hihat', 44:'hihat', 46:'hihat', 49:'hihat', 51:'hihat',
    52:'crash', 55:'crash', 57:'crash', 59:'crash',
    53:'perc', 54:'perc', 56:'perc', 58:'perc',
    60:'perc', 61:'perc', 62:'perc', 63:'perc', 64:'perc',
    65:'perc', 66:'perc', 67:'perc', 68:'perc', 69:'perc',
    70:'perc', 71:'perc', 72:'perc', 73:'perc', 74:'perc',
    75:'perc', 76:'perc', 77:'perc', 78:'clap', 79:'perc',
    80:'perc', 81:'hihat',
};

function encodeBase36(notes, gridBits) {
    const step = 1 << gridBits;
    const total = Math.ceil(Math.max(...notes.map(n => n.endSample), 1) / step);
    const channels = new Map();

    for (const n of notes) {
        const s = Math.min(total - 1, n.startSample / step | 0);
        if (!channels.has(n.channel)) channels.set(n.channel, new Array(total).fill(null));
        channels.get(n.channel)[s] = n.note;
    }

    return [...channels.entries()].map(([ch, arr]) => ({
        ch,
        type: 'base36',
        // offset +12 de C4(60) pra manter positivo no range 0-35 (C3..B5)
        str: arr.map(n => n === null ? '0' : Math.max(0, Math.min(35, n - 60 + 12)).toString(36)).join(''),
    }));
}

function encodeCharcode(notes, gridBits) {
    const step = 1 << gridBits;
    const total = Math.ceil(Math.max(...notes.map(n => n.endSample), 1) / step);
    const channels = new Map();

    for (const n of notes) {
        const s = Math.min(total - 1, n.startSample / step | 0);
        if (!channels.has(n.channel)) channels.set(n.channel, new Array(total).fill(60));
        channels.get(n.channel)[s] = n.note;
    }

    // offset de 32 = primeiro char printable do ASCII
    const BASE = 32;
    return [...channels.entries()].map(([ch, arr]) => ({
        ch,
        type: 'charcode',
        base: BASE,
        // clampa pra range printable seguro (33-126 = ! a ~)
        str: arr.map(n => String.fromCharCode(_clampI(n + BASE, 33, 126))).join(''),
    }));
}

function _clampI(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Gera a expressão compact final
function buildCompactExpression(notes, totalSamples, opts) {
    const { gridBits = 13, sr = DEFAULT_SR, encoding = 'base36', loop = true } = opts;

    const encodeFn = encoding === 'charcode' ? encodeCharcode : encodeBase36;
    const voices = encodeFn(notes, gridBits).slice(0, 4); // máximo 4 vozes
    if (!voices.length) return '0';

    const decls = [];
    const exprs = [];

    for (let i = 0; i < voices.length; i++) {
        const v = voices[i];
        const vname = `_s${i}`;
        const safeStr = v.str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        decls.push(`${vname}='${safeStr}'`);

        // Decodifica semitone offset → frequência
        // base36: parseInt(char, 36) - 12 = semitone offset relativo a C4
        //         -9 adicional ajusta pra A4=440
        // charcode: charCodeAt() - base - 69 = offset de A4
        let semiExpr;
        if (v.type === 'charcode') {
            semiExpr = `(${vname}.charCodeAt((t>>${gridBits})%${v.str.length})-${v.base}-69)`;
        } else {
            semiExpr = `(parseInt(${vname}[(t>>${gridBits})%${v.str.length}],36)-21)`;
        }

        // Oscilador: dente de serra inteiro (funciona em qualquer player com float)
        // freq_bytebeat = t * freqHz / SR    →    %256 = 8-bit wrap
        const oscExpr = `(t*440*Math.pow(2,${semiExpr}/12)/${sr}%256|0)`;
        exprs.push(oscExpr);
    }

    // Cria eco (delay de 1/3 loop) pra harmonia de terceiras
    const loopLen = totalSamples || (1 << (gridBits + 4));
    const echo    = Math.round(loopLen / 3);

    let mix;
    if (exprs.length === 1) {
        const e  = exprs[0];
        const e2 = e.replace(/\bt\b/g, `(t+${echo})`);
        const e3 = e.replace(/\bt\b/g, `(t+${echo * 2})`);
        mix = `((${e}+(${e2}>>1)+(${e3}>>2))*0.57|0)`;
    } else {
        mix = `((${exprs.join('+')})/${exprs.length}|0)`;
    }

    let expr = `(_SR=${sr},${decls.join(',')},${mix})`;
    if (loop && totalSamples > 0) expr = `(t=t%${totalSamples},${expr})`;
    return expr;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODO FLOAT — construtor da expressão principal
// ─────────────────────────────────────────────────────────────────────────────

function buildFloatExpression(notes, totalSamples, opts) {
    const {
        sr            = DEFAULT_SR,
        poly          = 8,
        loop          = true,
        channelPresets= {},
        defaultPreset = 'default',
        drumPreset    = 'auto',
        masterVol     = 2,
        gmPrograms    = {},
        stereo        = true,
        masterFx      = 'none',
    } = opts;

    if (!notes.length) return '0';

    // Determina preset por nota (canal + mapeamento GM)
    const getPreset = (n) => {
        if (channelPresets[n.channel]) return channelPresets[n.channel];
        if (n.channel === DRUM_CH) {
            return drumPreset === 'auto' ? (GM_DRUM[n.note] || 'perc') : drumPreset;
        }
        const prog = gmPrograms[n.channel];
        const mapped = prog !== undefined ? GM_PROG[prog] : null;
        return mapped || defaultPreset;
    };

    // Coleta presets únicos e cria índices
    const presetNames = [...new Set(notes.map(getPreset))];
    const presetIdx   = Object.fromEntries(presetNames.map((p, i) => [p, i]));

    // Definições de instrumento como string JS
    const instDefs = presetNames.map((p, i) =>
        `_I${i}=${FLOAT_PRESETS[p] ?? FLOAT_PRESETS.default}`
    ).join(',\n');

    // ── Polyfony greedy ─────────────────────────────────────────────────────
    // Tenta encaixar cada nota no slot mais antigo disponível
    const slots = Array.from({ length: poly }, () => []);
    for (const note of notes) {
        for (const slot of slots) {
            const last = slot[slot.length - 1];
            if (!last || last.endSample + RELEASE_TAIL <= note.startSample) {
                slot.push(note);
                break;
            }
        }
    }

    const active = slots.flat().sort((a, b) => a.startSample - b.startSample);

    // Gera array de dados de nota:
    // [start, end, freqHz, vel, instIdx, filterBase, pan]
    //   filterBase = i*20 → isola os 20 estados de filtro de cada nota
    //   pan 0.0=esquerda 0.5=centro 1.0=direita
    const noteData = active.map((n, i) => {
        const freq = 440 * Math.pow(2, (n.note - 69) / 12);
        const inst = presetIdx[getPreset(n)];
        const fb   = i * 20;
        // Percussão dispersa no stereo, melodia centrada
        const pan  = n.channel === DRUM_CH ? (n.note % 5) / 4 : 0.5;
        return `[${n.startSample},${n.endSample},${freq.toFixed(1)},${n.velocity},${inst},${fb},${pan.toFixed(2)}]`;
    });

    const instsArr = presetNames.map((_, i) => `_I${i}`).join(',');

    // ── Efeito master ────────────────────────────────────────────────────────
    let masterLine;
    if (masterFx === 'reverb') {
        // Reverb simples: reflexões com LPF
        masterLine = [
            `var oL=L,oR=R`,
            `L=(oL+(_z[9900]??0)*0.38+(_z[9901]??0)*0.18)`,
            `R=(oR+(_z[9902]??0)*0.38+(_z[9903]??0)*0.18)`,
            `_z[9901]=_z[9900];_z[9900]=_lp(oL,0.65,9910)`,
            `_z[9903]=_z[9902];_z[9902]=_lp(oR,0.65,9911)`,
        ].join(';');
    } else if (masterFx === 'compress') {
        masterLine = `L=_tanh(L*1.35);R=_tanh(R*1.35)`;
    } else {
        masterLine = '';
    }

    const retExpr = stereo
        ? `[_clamp(L,0,255)|0, _clamp(R,0,255)|0]`
        : `_clamp((L+R)/2,0,255)|0`;

    // ── Monta expressão completa ─────────────────────────────────────────────
    //
    // Estrutura:
    //   t?0:(init_block)    → roda uma vez em t=0, define globals
    //   ,(()=>{...})()      → IIFE avaliada a cada sample, usa tt=t%TOTAL pra loop
    //
    // Motivo do t?0: em vez de t=t%TOTAL no topo:
    //   Se t=t%TOTAL, no boundary do loop t volta a 0 e o init roda de novo.
    //   Com t crescendo infinito + tt local, o init roda só uma vez.
    //   Filtros preservam estado entre loops → sem click no boundary.

    const totalVal = loop && totalSamples > 0 ? totalSamples : 0;
    const ttDecl   = totalVal > 0 ? `var tt=t%${totalVal}` : `var tt=t`;

    const iife = [
        `(()=>{`,
        `  ${ttDecl},L=0,R=0,cnt=0,i,n,s,age;`,
        `  for(i=0;i<_N.length;i++){`,
        `    n=_N[i];`,
        `    if(tt>=n[0]&&tt<n[1]+${RELEASE_TAIL}&&cnt<${poly}){`,
        `      age=tt-n[0];`,
        `      s=_clamp(_INSTS[n[4]](age,n[1]-n[0],n[2],n[3],n[5]),-1,1);`,
        `      L+=s*(1-n[6]);R+=s*n[6];cnt++`,
        `    }`,
        `  }`,
        masterLine ? `  ${masterLine};` : '',
        `  L=_tanh(L/${masterVol})*127+127;`,
        `  R=_tanh(R/${masterVol})*127+127;`,
        `  return ${retExpr}`,
        `})()`,
    ].filter(Boolean).join('\n');

    return [
        `//BY NYZXOR.CC \n//discord: p6x6 \n \n t?0:(${dspEngineHeader(sr)},\n${instDefs},\n_N=[${noteData.join(',\n')}],\n_INSTS=[${instsArr}])`,
        iife,
    ].join(',\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// MODO INTEGER (CLÁSSICO)
// Bytebeat puro em inteiros, compatível com qualquer player
// ─────────────────────────────────────────────────────────────────────────────

const INT_WAVES = {
    square:   p => `(t/${p}&1?127:-128)`,
    saw:      p => `((t%${p})*255/${p}-128)`,
    rsaw:     p => `(128-(t%${p})*255/${p})`,
    triangle: p => { const h = p >> 1; return `((t%${p}<${h}?(t%${p})*254/${h}-127:381-(t%${p})*254/${h}))`; },
    pulse25:  p => `(t/${p}%4===0?127:-128)`,
    organ:    p => { const p2 = Math.max(1, p >> 1); return `((t/${p}&1?64:-64)+(t/${p2}&1?32:-32))`; },
    bass:     p => `(t/${Math.min(65535, p * 2)}&1?96:-96)`,
    fm:       p => `((t/(${p}+(t/${Math.max(1, p >> 1)}&31)))&1?110:-110)`,
    chip:     p => `(t/(${p}+(t>>7&${Math.max(1, Math.round(p * 0.02))}))&1?100:-100)`,
    pwm:      p => `(t%${p}<(t>>4&${Math.max(1, p - 1)})?110:-110)`,
    supersaw: p => {
        const p2 = Math.max(1, p + 2), p3 = Math.max(1, p - 2);
        return `(((t%${p})*255/${p}+((t%${p2})*255/${p2})+((t%${p3})*255/${p3}))/3-128)`;
    },
};

function noteToperiod(note, sr) {
    if (note < 0 || note > 127) return null;
    return Math.max(1, Math.round(sr / (440 * Math.pow(2, (note - 69) / 12))));
}

function buildIntegerExpression(notes, totalSamples, opts) {
    const { waveform = 'square', poly = 8, sr = DEFAULT_SR, loop = true, transpose = 0 } = opts;
    const waveFn = INT_WAVES[waveform];
    if (!waveFn) throw new MidiError(`Waveform inválida: ${waveform}`, 'BAD_WAVE');

    const shifted = notes.map(n => ({
        ...n,
        note: Math.min(127, Math.max(0, n.note + transpose)),
    }));

    const slots = Array.from({ length: poly }, () => []);
    for (const note of shifted) {
        for (const slot of slots) {
            const last = slot[slot.length - 1];
            if (!last || last.endSample <= note.startSample) { slot.push(note); break; }
        }
    }

    const slotExprs = [];
    for (const slot of slots) {
        if (!slot.length) continue;
        let expr = '0';
        for (let i = slot.length - 1; i >= 0; i--) {
            const { note, startSample, endSample, velocity } = slot[i];
            const p  = noteToperiod(note, sr);
            if (!p) continue;
            const vd = Math.max(1, Math.round(128 / (velocity || 100)));
            let we   = waveFn(p);
            if (vd > 1) we = `((${we})/${vd})`;
            expr = `(t>=${startSample}&&t<${endSample}?${we}:${expr})`;
        }
        slotExprs.push(expr);
    }

    if (!slotExprs.length) return '0';
    let combined = slotExprs.length === 1
        ? slotExprs[0]
        : `((${slotExprs.join('+')})/${slotExprs.length})`;

    if (loop && totalSamples > 0) combined = `(t=t%${totalSamples},${combined})`;
    return combined;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSER MIDI
// ─────────────────────────────────────────────────────────────────────────────

function validateFile(p) {
    if (!p) throw new MidiError('Caminho não especificado', 'NO_PATH');
    if (!fs.existsSync(p)) throw new MidiError(`Arquivo não encontrado: ${p}`, 'NOT_FOUND');
    const ext = path.extname(p).toLowerCase();
    if (!['.mid', '.midi'].includes(ext)) throw new MidiError(`Extensão inválida: ${ext}`, 'BAD_EXT');
    const { size } = fs.statSync(p);
    if (size > MAX_FILE_SIZE) throw new MidiError('Arquivo muito grande (max 10MB)', 'TOO_BIG');
    if (size === 0) throw new MidiError('Arquivo vazio', 'EMPTY');
}

function parseMidiFile(filePath, sr) {
    const midi = parseMidi(fs.readFileSync(filePath));
    if (!midi?.header || !midi.tracks?.length)
        throw new MidiError('MIDI inválido ou corrompido', 'BAD_MIDI');

    let tempo = DEFAULT_TEMPO;
    const tpb  = midi.header.ticksPerBeat || 480;
    const programs = {}; // canal → GM program number

    // Pega o primeiro setTempo (geralmente no track 0)
    for (const ev of midi.tracks[0]) {
        if (ev.type === 'setTempo') { tempo = ev.microsecondsPerBeat; break; }
    }

    const t2s = tick => Math.floor(tick * tempo / 1_000_000 * sr / tpb);
    const notes = [];
    let maxSample = 0;

    midi.tracks.forEach((track, ti) => {
        let tick = 0;
        const active = new Map(); // "ch-note" → { tick, vel }

        for (const ev of track) {
            tick += ev.deltaTime;

            if (ev.type === 'programChange') {
                programs[ev.channel] = ev.programNumber;

            } else if (ev.type === 'noteOn' && ev.velocity > 0) {
                active.set(`${ev.channel}-${ev.noteNumber}`, { tick, vel: ev.velocity });

            } else if (ev.type === 'noteOff' || (ev.type === 'noteOn' && ev.velocity === 0)) {
                const key = `${ev.channel}-${ev.noteNumber}`;
                const st  = active.get(key);
                if (st) {
                    const ss = t2s(st.tick);
                    const es = t2s(tick);
                    if (es > ss) {
                        notes.push({
                            note:        ev.noteNumber,
                            startSample: ss,
                            endSample:   es,
                            channel:     ev.channel,
                            velocity:    st.vel,
                            track:       ti,
                        });
                        maxSample = Math.max(maxSample, es + RELEASE_TAIL);
                    }
                    active.delete(key);
                }
            }
        }
    });

    notes.sort((a, b) => a.startSample - b.startSample);

    // Remove silêncio inicial do MIDI pra o loop voltar instantâneo.
    const firstStart = notes.length ? notes[0].startSample : 0;
    if (firstStart > 0) {
        for (const n of notes) {
            n.startSample -= firstStart;
            n.endSample   -= firstStart;
        }
        maxSample = Math.max(1, maxSample - firstStart);
    }

    return { notes, totalSamples: Math.max(maxSample, 1), programs, tempo };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSOR PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

async function convertMidi(opts) {
    validateFile(opts.input);

    const sr = parseInt(opts.sr || DEFAULT_SR);
    const { notes, totalSamples, programs } = parseMidiFile(opts.input, sr);
    if (!notes.length) throw new MidiError('Nenhuma nota encontrada no arquivo', 'NO_NOTES');

    // Parse "--presets 0:piano,1:bass,9:kick"
    const channelPresets = {};
    if (opts.presets) {
        for (const p of String(opts.presets).split(',')) {
            const [ch, pre] = p.trim().split(':');
            if (ch !== undefined && pre) channelPresets[+ch] = pre.trim();
        }
    }

    const mode = (opts.mode || 'float').toLowerCase();
    let expression;

    switch (mode) {
        case 'float':
            expression = buildFloatExpression(notes, totalSamples, {
                sr,
                poly:          parseInt(opts.poly || 8),
                loop:          opts.loop !== false,
                channelPresets,
                defaultPreset: opts.preset || 'default',
                gmPrograms:    programs,
                masterFx:      opts.fx || 'none',
                stereo:        opts.stereo !== false,
                masterVol:     parseFloat(opts.vol || 4),
            });
            break;

        case 'compact':
        case 'charcode':
            expression = buildCompactExpression(notes, totalSamples, {
                sr,
                gridBits: parseInt(opts.grid || 13),
                encoding: mode === 'charcode' ? 'charcode' : (opts.encoding || 'base36'),
                loop:     opts.loop !== false,
            });
            break;

        case 'integer':
        default:
            expression = buildIntegerExpression(notes, totalSamples, {
                waveform:  opts.waveform || 'square',
                poly:      parseInt(opts.poly || 8),
                sr,
                loop:      opts.loop !== false,
                transpose: parseInt(opts.transpose || 0),
            });
    }

    if (expression.length > 4 * 1024 * 1024)
        throw new MidiError('Expressão gerada muito grande (>4MB)', 'TOO_LARGE');

    const outDir = path.dirname(path.resolve(opts.output));
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(opts.output, expression, 'utf8');

    return { expression, totalSamples, noteCount: notes.length, sr, programs, mode };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {

program
    .name('midi2bytebeat')
    .version('3.0.0')
    .description('MIDI → Bytebeat by nyzxor.cc (discord: p6x6)')
    .option('-i, --input <path>',    'Arquivo MIDI de entrada')
    .option('-o, --output <path>',   'Arquivo de saída', 'output.bytebeat.js')
    // Modo
    .option('-m, --mode <mode>',     'Modo: float | integer | compact | charcode', 'float')
    // Modo float
    .option('--preset <name>',       'Preset padrão (ex: piano, lead, pad)')
    .option('--presets <map>',       'Preset por canal: "0:piano,1:bass,9:kick"')
    .option('--fx <effect>',         'FX master: none | reverb | compress', 'none')
    .option('--vol <n>',             'Volume master (divisor, menor=mais alto)', '4')
    .option('--no-stereo',           'Saída mono ao invés de [L,R]')
    // Modo integer
    .option('-w, --waveform <type>', 'Waveform (integer): square|saw|rsaw|triangle|pulse25|organ|bass|fm|chip|pwm|supersaw', 'square')
    .option('--transpose <n>',       'Transpõe N semitons (integer)', '0')
    // Modo compact
    .option('--encoding <type>',     'Encoding (compact): base36 | charcode', 'base36')
    .option('--grid <bits>',         'Grid em bits (compact), padrão 13 = 8192 samples/step', '13')
    // Comuns
    .option('-p, --poly <n>',        'Vozes simultâneas, padrão 8', '8')
    .option('--sr <hz>',             'Sample rate do player, padrão 8000', '8000')
    .option('--no-loop',             'Desativa loop')
    .option('-v, --verbose',         'Mostra mais info + preview da expressão', false)
    // Info
    .option('--list-presets',        'Lista presets de instrumento (modo float)')
    .option('--list-modes',          'Lista os modos de geração disponíveis')
    .option('--list-waveforms',      'Lista waveforms (modo integer)');

program.parse(process.argv);
const opts = program.opts();

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    // ── Subcomandos de info ──────────────────────────────────────────────────

    if (opts.listPresets) {
        const descs = {
            piano:    'Piano acústico — FM + decaimento natural',
            epiano:   'Rhodes/E-Piano — vibrato suave + FM',
            organ:    'Órgão Hammond — 6 harmônicos aditivos',
            lead:     'Synth lead — saw+sq com filtro dinâmico',
            bass:     'Baixo sintético — sub-harmônicos + LPF',
            subbass:  'Sub-bass profundo — só fundamentais filtrados',
            pad:      'Pad atmosférico — ataque lento + chorus',
            strings:  'Cordas com vibrato crescente',
            brass:    'Metais — filter sweep agressivo no ataque',
            flute:    'Flauta — vibrato + breath noise',
            pluck:    'Pluck/Guitarra — decaimento exponencial por freq',
            bell:     'Sino — FM multi-op com longa cauda',
            marimba:  'Marimba/Vibrafone — FM percussivo',
            clav:     'Clavinet — pluck nasal tipo Hohner',
            tb303:    'Synth Bass 303 — filter sweep percussivo',
            kick:     'Bumbo — sine sweep descendente',
            snare:    'Caixa — noise + tom',
            hihat:    'Hi-hat — noise HP (dur<500ms=fechado)',
            clap:     'Palma — noise BP em camadas',
            crash:    'Crash/Cymbal — noise de alta frequência',
            tom:      'Tom — sine sweep + noise',
            perc:     'Percussão genérica — noise BP + tom',
            supersaw: 'Supersaw — 7 saws desafinados, som gordo de trance',
        };
        console.log('\n🎹  Presets disponíveis (modo float):\n');
        for (const [k, v] of Object.entries(descs))
            console.log(`  ${k.padEnd(12)} ${v}`);
        console.log('\n  Canal MIDI 9 usa GM_DRUM_MAP automaticamente.');
        console.log('  Use --presets "9:snare" pra forçar um preset.\n');
        process.exit(0);
    }

    if (opts.listModes) {
        console.log('\n⚙️   Modos de geração:\n');
        console.log('  float     DSP engine completo: filtros, ADSR, FM, presets, stereo [L,R]');
        console.log('            Requer: Greggman html5bytebeat ou Dollchan (Floatbeat mode)');
        console.log();
        console.log('  integer   Bytebeat clássico em inteiros — máxima compatibilidade');
        console.log('            Funciona em qualquer player (Bytebeat mode)');
        console.log();
        console.log('  compact   Notas como string base36 (estilo "blue da ba dee")');
        console.log('            Expressão curta, harmonia de eco automática');
        console.log('            Requer: Floatbeat');
        console.log();
        console.log('  charcode  Notas via charCodeAt() — encoding ASCII printable');
        console.log('            Requer: Floatbeat');
        console.log();
        console.log('  Players:');
        console.log('  → https://greggman.com/downloads/examples/html5bytebeat/html5bytebeat.html');
        console.log('  → https://dollchan.net/bytebeat/\n');
        process.exit(0);
    }

    if (opts.listWaveforms) {
        const d = {
            square:   'Quadrada — o som padrão do bytebeat',
            saw:      'Dente de serra — rico em harmônicos',
            rsaw:     'Dente de serra invertido',
            triangle: 'Triângulo — sonoridade suave',
            pulse25:  'Pulso 25% duty cycle — nasal, tipo NES/GameBoy',
            organ:    'Órgão — quadrada + oitava acima',
            bass:     'Bass — sub-oitava de quadrada',
            fm:       'FM inteiro — timbre metálico/sino',
            chip:     'Chiptune com LFO/vibrato',
            pwm:      'PWM dinâmico — largura de pulso variável',
            supersaw: 'Supersaw — 3 saws desafinados, textura grossa',
        };
        console.log('\n🎛️   Waveforms (modo integer):\n');
        for (const [k, v] of Object.entries(d))
            console.log(`  ${k.padEnd(12)} ${v}`);
        console.log();
        process.exit(0);
    }

    if (!opts.input) {
        console.error('\nErro: -i / --input é obrigatório\n');
        program.help();
        process.exit(1);
    }

    console.log(banner);
    console.log(`📂  Input   : ${opts.input}`);
    console.log(`💾  Output  : ${opts.output}`);
    console.log(`⚙️   Mode    : ${opts.mode || 'float'}`);

    const mode = (opts.mode || 'float').toLowerCase();
    if (mode === 'float') {
        console.log(`🎹  Preset  : ${opts.preset || 'auto (GM map)'}`);
        console.log(`✨  FX      : ${opts.fx || 'none'}`);
        console.log(`🔊  Stereo  : ${opts.stereo !== false}`);
    } else if (mode === 'integer') {
        console.log(`🎵  Waveform: ${opts.waveform || 'square'}`);
        if (opts.transpose && opts.transpose !== '0')
            console.log(`⬆️   Transp. : ${opts.transpose} semitones`);
    } else {
        console.log(`🗜️   Encoding: ${mode === 'charcode' ? 'charcode' : (opts.encoding || 'base36')}`);
        console.log(`📐  Grid    : ${opts.grid || 13} bits = ${1 << +(opts.grid || 13)} samples/step`);
    }
    console.log(`🎹  Poly    : ${opts.poly || 8} voices`);
    console.log(`📡  SR      : ${opts.sr || DEFAULT_SR} Hz`);

    const t0 = Date.now();

    try {
        const result  = await convertMidi(opts);
        const elapsed = Date.now() - t0;

        console.log('\n✅  Concluído!\n');
        console.log(`📊  Notas       : ${result.noteCount}`);
        console.log(`    Duração     : ${(result.totalSamples / result.sr).toFixed(2)}s  (${result.totalSamples} samples)`);
        console.log(`    Expressão   : ${result.expression.length} chars`);
        console.log(`    Processado  : ${elapsed}ms`);

        if (Object.keys(result.programs).length) {
            const pg = Object.entries(result.programs)
                .map(([ch, p]) => `ch${ch}→GM#${p}`).join(' | ');
            console.log(`    GM Programs : ${pg}`);
        }

        if (opts.verbose) {
            console.log('\n📝  Preview (300 chars):');
            console.log('    ' + result.expression.slice(0, 300) +
                (result.expression.length > 300 ? '…' : ''));
        }

        console.log('\n🎮  Como ouvir:');
        if (result.mode !== 'integer') {
            console.log('    → https://greggman.com/downloads/examples/html5bytebeat/html5bytebeat.html');
            console.log(`    Configurar: Floatbeat | ${result.sr}Hz${result.mode === 'float' && opts.stereo !== false ? ' | Stereo' : ''}`);
        } else {
            console.log('    → https://dollchan.net/bytebeat/');
            console.log(`    Configurar: Bytebeat | ${result.sr}Hz`);
        }
        console.log();

    } catch (err) {
        console.error('\n❌  Erro:', err.message);
        if (opts.verbose && err.stack) console.error('\n' + err.stack);
        process.exit(1);
    }
}

main();

} // end require.main === module

module.exports = {
    parseMidiFile,
    buildFloatExpression,
    buildIntegerExpression,
    buildCompactExpression,
    FLOAT_PRESETS,
    INT_WAVES,
};
