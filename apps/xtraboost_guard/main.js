'use strict';
/**
 * XtraBoost Guard - Custom MGU App for BMW G30 530e PHEV (Stage 1 B48 420 KM).
 *
 * Zakładka 1: "XtraBoost Guard" (Dual Power Split 420 KM, Detektor BMS, 100-200 Ready, Monitor Paliwa PB95 vs PB98)
 * Zakładka 2: "Warmup & Turbo" (Ochrona Zimnego B48, Dynamiczny Limit RPM/Boost, Strażnik Cooldown Turbiny)
 * Zakładka 3: "Service Tracker" (Inteligentny Licznik Przebiegu B48 vs EV, Olej Millers, Filtr, Świece NGK)
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const Car = require('./kit/car');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { split } = require('./kit/sgbd');

const W = 1600, H = 520;
const GO = '#2fd27a';
const WARN = '#f59e0b';
const CRIT = '#ef4444';
const BLUE = '#0066b1';
const M_CYAN = '#00a3e0';

// Nominal performance specs for G30 530e Stage 1
const SPEC = {
    iceMaxHp: 311,
    iceMaxNm: 440,
    evMaxHp: 109,
    evMaxNm: 265,
    systemMaxHp: 420,
    targetBoostBar: 1.50
};

// Seed data for BMW G30 530e Service Tracker
const DEFAULT_SERVICE_STATE = {
    baseOdo: 113000,
    lastOdo: 113000,
    totalIceKm: 0,
    totalEvKm: 0,
    intervals: [
        {
            id: 'oil',
            name: 'Olej silnikowy (Millers 5W-40)',
            limitKm: 10500,
            currentKm: 0,
            spec: 'Millers EE Performance 5W-40'
        },
        {
            id: 'air_filter',
            name: 'Filtr powietrza',
            limitKm: 21000,
            currentKm: 2800,
            spec: 'Wkladka OE / sportowa (start: 2800 km)'
        },
        {
            id: 'spark_plugs',
            name: 'Swiece zaplonowe NGK',
            limitKm: 35000,
            currentKm: 0,
            spec: 'NGK Iridium (start: 0 km)'
        }
    ]
};

/* ---------------- Fallback Emergency Crash Screen ---------------- */
function drawCrashScreen(cv, t, err, stage) {
    cv.clear('#0d0505');
    // Top alert banner
    cv.roundRect(20, 20, W - 40, 70, 8, '#770000');
    cv.text('BLAD KRYTYCZNY (CRASH) W IDRIVE - XTRABOOST GUARD', 40, 64, 26, '#ffffff', { font: 'bold' });

    // Details panel
    cv.roundRect(20, 106, W - 40, 394, 8, withAlpha('#ffffff', 0.05));
    cv.strokeRoundRect(20, 106, W - 40, 394, 8, 2, '#ff3333');

    cv.text('ETAP WYSTAPIENIA BLEDU: ' + (stage || 'STARTUP / RENDER'), 40, 145, 20, WARN, { font: 'bold' });

    const errMsg = String(err && err.message ? err.message : err);
    cv.text('KOMUNIKAT BLEDU:', 40, 185, 18, '#aaaaaa', { font: 'bold' });
    cv.roundRect(40, 200, W - 80, 50, 6, '#220000');
    cv.text(errMsg.slice(0, 110), 55, 234, 20, '#ff6666', { font: 'bold' });

    cv.text('STACK TRACE (SLAD BLEDU):', 40, 280, 18, '#aaaaaa', { font: 'bold' });
    const stack = (err && err.stack ? err.stack.split('\n') : [errMsg]).slice(0, 7);
    stack.forEach((line, i) => {
        cv.text(line.trim().slice(0, 130), 50, 312 + i * 24, 16, '#dddddd');
    });

    cv.text('APLIKACJA NIE ZOSTALA ZAMKNIETA. Zrob zdjecie powyzszego bledu, aby zidentyfikowac przyczyne.', 40, 485, 17, GO, { font: 'bold' });
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let fatalError = null;
        let fatalStage = '';

        try {
            // Common driving signals from SOME/IP
            const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque', 'accel']);
            car.setRedline(6500);

            // Read-only diagnostic link for DME (0x12) - delayed 2.0s to allow UI and TASU IPC sockets to settle
            let diag = null;
            setTimeout(() => {
                try {
                    diag = new ReadOnlyDiag(ctx.signals, log);
                    diag.init()
                        .then(() => log.info('ReadOnlyDiag connected to DME (0x12) successfully'))
                        .catch((e) => log.warn('ReadOnlyDiag init warning: ' + e));
                } catch (e) {
                    log.warn('ReadOnlyDiag creation warning: ' + e);
                }
            }, 2000);

            /* ---------------- State & Persistence ---------------- */
            const STATE_FILE = path.join(ctx.dataDir, 'service_state.json');
            const BUNDLED_FILE = path.join(__dirname, 'data', 'service_state.json');
            let serviceState = null;

            function loadServiceState() {
                try {
                    fs.mkdirSync(ctx.dataDir, { recursive: true });
                    if (fs.existsSync(STATE_FILE)) {
                        serviceState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                    } else if (fs.existsSync(BUNDLED_FILE)) {
                        serviceState = JSON.parse(fs.readFileSync(BUNDLED_FILE, 'utf8'));
                    }
                } catch (e) {
                    log.warn('loadServiceState error: ' + (e && e.message ? e.message : e));
                }
                if (!serviceState || !Array.isArray(serviceState.intervals)) {
                    serviceState = JSON.parse(JSON.stringify(DEFAULT_SERVICE_STATE));
                    saveServiceState();
                }
            }

            function saveServiceState() {
                try {
                    fs.mkdirSync(ctx.dataDir, { recursive: true });
                    const tmp = STATE_FILE + '.' + process.pid + '.tmp';
                    fs.writeFileSync(tmp, JSON.stringify(serviceState, null, 2), 'utf8');
                    fs.renameSync(tmp, STATE_FILE);
                } catch (e) {
                    log.warn('saveServiceState error: ' + (e && e.message ? e.message : e));
                }
            }

            loadServiceState();

        /* ---------------- App Navigation & Tabs ---------------- */
        const TABS = ['XTRABOOST GUARD', 'WARMUP & TURBO', 'SERVICE TRACKER'];
        let activeTab = 0;
        let selectedServiceIdx = 0;
        let serviceConfirmUntil = 0;

        function updateBarButtons() {
            if (activeTab === 0) {
                ui.text('BTN_ACTION', 'Reset Peak');
            } else if (activeTab === 1) {
                ui.text('BTN_ACTION', 'Kasuj Cooldown');
            } else if (activeTab === 2) {
                const isArmed = Date.now() < serviceConfirmUntil;
                const it = serviceState.intervals[selectedServiceIdx];
                ui.text('BTN_ACTION', isArmed ? 'POTWIERDZ RESET!' : 'Resetuj: ' + (it ? it.id : 'CBS'));
            }
        }

        const flipNext = () => { activeTab = (activeTab + 1) % 3; serviceConfirmUntil = 0; updateBarButtons(); render(); };
        const flipPrev = () => { activeTab = (activeTab + 2) % 3; serviceConfirmUntil = 0; updateBarButtons(); render(); };

        ui.onClick('BTN_PAGE', flipNext);
        ui.onClick('BTN_PREV', flipPrev);
        ctx.onTab((i) => {
            if (i >= 0 && i < 3 && i !== activeTab) {
                activeTab = i;
                serviceConfirmUntil = 0;
                updateBarButtons();
                render();
            }
        });

        // Touch support on screen
        ctx.onTap((x, y) => {
            if (activeTab === 2) {
                // Tapping on service item rows to select them
                const itemY0 = 46 + 86;
                const itemH = 104;
                for (let i = 0; i < serviceState.intervals.length; i++) {
                    const iy = itemY0 + i * (itemH + 12);
                    if (x >= 36 && x <= 1040 && y >= iy && y <= iy + itemH) {
                        selectedServiceIdx = i;
                        serviceConfirmUntil = 0;
                        updateBarButtons();
                        render();
                        break;
                    }
                }
            }
        });

        // Action button handler
        ui.onClick('BTN_ACTION', () => {
            if (activeTab === 0) {
                resetPeaks();
                render();
            } else if (activeTab === 1) {
                cooldownRemaining = 0;
                render();
            } else if (activeTab === 2) {
                const now = Date.now();
                if (now < serviceConfirmUntil) {
                    const it = serviceState.intervals[selectedServiceIdx];
                    if (it) {
                        it.currentKm = 0;
                        saveServiceState();
                        log.info('CBS Reset executed for: ' + it.name);
                    }
                    serviceConfirmUntil = 0;
                } else {
                    serviceConfirmUntil = now + 5000;
                }
                updateBarButtons();
                render();
            }
        });

        /* ---------------- Tab 1: Live Diagnostic Tracking (DME + SME) ---------------- */
        const liveDiag = {
            boostActual: 0.0,
            boostTarget: 1.5,
            iat: 32.0,
            baseTiming: 12.0,
            cylCorr: [0.0, 0.0, 0.0, 0.0],
            peakBoost: 0.0,
            peakIat: 0.0,
            peakCorr: [0.0, 0.0, 0.0, 0.0],
            soc: 65,
            hvVolts: 350.0,
            hvAmps: 0.0,
            dischargeLimitA: 260.0,
            bmsRealData: false,
            derateRatio: 1.0,
            wot: false
        };

        function resetPeaks() {
            liveDiag.peakBoost = liveDiag.boostActual;
            liveDiag.peakIat = liveDiag.iat;
            liveDiag.peakCorr = [0.0, 0.0, 0.0, 0.0];
            log.info('Peaks reset');
        }

        const DME_DIDS = [0x4205, 0x4AB0, 0x580F, 0x59FA, 0x4A49, 0x4A4A, 0x4A4C, 0x4A4D];
        const DME_LENS = { 0x4205: 2, 0x4AB0: 2, 0x580F: 1, 0x59FA: 1, 0x4A49: 2, 0x4A4A: 2, 0x4A4C: 2, 0x4A4D: 2 };

        const SME_DIDS = [0xDD7D, 0xDDB4, 0xDD69];
        const SME_LENS = { 0xDD7D: 4, 0xDDB4: 2, 0xDD69: 4 };

        let diagBusy = false;
        async function pollDmeDiag() {
            if (diagBusy || !diag || !diag.ready) return;
            diagBusy = true;
            try {
                const reply = await diag.readMany(0x12, DME_DIDS, 1000);
                if (reply && reply[0] === 0x62) {
                    const parts = split(reply, DME_LENS);
                    if (parts) {
                        if (parts[0x4205]) {
                            const raw = (parts[0x4205][3] << 8) | parts[0x4205][4];
                            const hpa = raw * 0.078125;
                            liveDiag.boostActual = Math.max(0, (hpa - 1013) / 1000);
                        }
                        if (parts[0x4AB0]) {
                            const raw = (parts[0x4AB0][3] << 8) | parts[0x4AB0][4];
                            const hpa = raw * 0.0390625;
                            liveDiag.boostTarget = Math.max(0, (hpa - 1013) / 1000);
                        }
                        if (parts[0x580F]) {
                            const raw = parts[0x580F][3];
                            liveDiag.iat = raw * 0.75 - 48.0;
                        }
                        if (parts[0x59FA]) {
                            let raw = parts[0x59FA][3];
                            if (raw >= 128) raw -= 256;
                            liveDiag.baseTiming = raw * 0.75;
                        }
                        [0x4A49, 0x4A4A, 0x4A4C, 0x4A4D].forEach((did, idx) => {
                            if (parts[did]) {
                                let raw = (parts[did][3] << 8) | parts[did][4];
                                if (raw >= 32768) raw -= 65536;
                                const deg = raw * 0.1;
                                const diff = deg - liveDiag.baseTiming;
                                liveDiag.cylCorr[idx] = Math.round(diff * 10) / 10;
                            }
                        });
                    }
                }
            } catch (err) {
                // Diag error caught cleanly
            } finally {
                diagBusy = false;
            }
        }

        async function pollSmeDiag() {
            if (diagBusy || !diag || !diag.ready) return;
            diagBusy = true;
            try {
                const reply = await diag.readMany(0x07, SME_DIDS, 1000);
                if (reply && reply[0] === 0x62) {
                    const parts = split(reply, SME_LENS);
                    if (parts) {
                        if (parts[0xDD7D]) {
                            const rawDischarge = (parts[0xDD7D][5] << 8) | parts[0xDD7D][6];
                            const disA = rawDischarge * 0.1;
                            if (disA > 10 && disA < 600) {
                                liveDiag.dischargeLimitA = disA;
                                liveDiag.bmsRealData = true;
                            }
                        }
                        if (parts[0xDDB4]) {
                            const rawV = (parts[0xDDB4][3] << 8) | parts[0xDDB4][4];
                            const v = rawV * 0.01;
                            if (v > 180 && v < 450) {
                                liveDiag.hvVolts = v;
                            }
                        }
                        if (parts[0xDD69]) {
                            let rawA = (parts[0xDD69][3] << 24) | (parts[0xDD69][4] << 16) | (parts[0xDD69][5] << 8) | parts[0xDD69][6];
                            const a = rawA * 0.01;
                            liveDiag.hvAmps = Math.abs(a);
                        }
                    }
                }
            } catch (err) {
                // SME read caught cleanly
            } finally {
                diagBusy = false;
            }
        }

        let diagStep = 0;
        setInterval(() => {
            if (activeTab === 0 && diag && diag.ready) {
                diagStep = (diagStep + 1) % 3;
                if (diagStep === 0) {
                    pollSmeDiag();
                } else {
                    pollDmeDiag();
                }
            }
        }, 200);

        /* ---------------- Tab 2: Warmup & Turbo Cooldown Tracking ---------------- */
        let cooldownRemaining = 0;
        let lastCooldownTick = Date.now();

        /* ---------------- Synthetic / Demo Driving Generator ---------------- */
        let demoPhase = 0;
        let demoOdoAccumulator = 0;

        function updateDemoState(d, dt) {
            demoPhase += dt * 0.8;
            const isHardAcc = (Math.sin(demoPhase) > 0.2);

            if (isHardAcc) {
                liveDiag.wot = true;
                liveDiag.boostTarget = 1.50;
                liveDiag.boostActual = Math.min(1.52, Math.max(0.2, 1.48 + 0.05 * Math.sin(demoPhase * 4)));
                liveDiag.iat = Math.min(48, 33 + 8 * (0.5 + 0.5 * Math.sin(demoPhase * 0.5)));
                liveDiag.baseTiming = 11.5 + 2 * Math.cos(demoPhase * 2);
                liveDiag.cylCorr[0] = -0.4;
                liveDiag.cylCorr[1] = -0.8;
                liveDiag.cylCorr[2] = (Math.sin(demoPhase * 2.5) > 0.6) ? -3.4 : -1.2;
                liveDiag.cylCorr[3] = -0.2;
            } else {
                liveDiag.wot = false;
                liveDiag.boostTarget = 0.60;
                liveDiag.boostActual = Math.max(0.0, 0.15 * Math.sin(demoPhase));
                liveDiag.iat = 32.0;
                liveDiag.baseTiming = 18.0;
                liveDiag.cylCorr[0] = 0.0;
                liveDiag.cylCorr[1] = -0.2;
                liveDiag.cylCorr[2] = -0.4;
                liveDiag.cylCorr[3] = 0.0;
            }

            liveDiag.soc = 50 + 28 * Math.sin(demoPhase * 0.15);
            liveDiag.dischargeLimitA = (liveDiag.soc < 25) ? 160.0 : 255.0;
            liveDiag.hvVolts = 352.0;
            liveDiag.bmsRealData = true;
            if (isHardAcc) {
                liveDiag.hvAmps = 220.0;
            } else {
                liveDiag.hvAmps = 15.0;
            }

            demoOdoAccumulator += (d.speed || 60) * (dt / 3600);
            if (demoOdoAccumulator >= 0.1) {
                const addKm = 0.1;
                demoOdoAccumulator -= 0.1;
                const odo = (serviceState.lastOdo || 113000) + addKm;
                updateOdometer(odo, d.rpm, d.speed);
            }
        }

        /* ---------------- Background Odometer Tracking ---------------- */
        function updateOdometer(newOdo, rpm, speed) {
            if (!G.isNum(newOdo) || newOdo <= 0) return;
            if (!serviceState.lastOdo) {
                serviceState.lastOdo = newOdo;
                saveServiceState();
                return;
            }
            const delta = newOdo - serviceState.lastOdo;
            if (delta > 0 && delta < 50) {
                if (G.isNum(rpm) && rpm > 0) {
                    serviceState.totalIceKm += delta;
                    serviceState.intervals.forEach((it) => { it.currentKm += delta; });
                } else {
                    serviceState.totalEvKm += delta;
                }
                serviceState.lastOdo = newOdo;
                saveServiceState();
            }
        }

        ctx.signals.watch('de.bmw.infotainment.KombiIF', '1', {
            statusRangeTankStatus: (v) => {
                if (v && G.isNum(v.mileageKilometre) && v.mileageKilometre < 16777215) {
                    const d = car.data();
                    updateOdometer(v.mileageKilometre, d.rpm, d.speed);
                }
            }
        }, log).catch((e) => log.warn('KombiIF watch: ' + e));

        ctx.signals.watch('de.bmw.infotainment.lsc.LSCDataSink', '1', {
            statusHighVoltageStorage: (v) => {
                if (v && G.isNum(v.actualValueStateOfCharge)) {
                    liveDiag.soc = v.actualValueStateOfCharge;
                }
            }
        }, log).catch((e) => log.warn('LSCDataSink watch: ' + e));

        /* ---------------- Main Render Function ---------------- */
        async function render() {
            if (fatalError) {
                const cv = ctx.canvas(W, H);
                drawCrashScreen(cv, ctx.theme(), fatalError, fatalStage);
                return ui.image('MAIN_GFX', cv);
            }
            try {
                const t = ctx.theme();
                const cv = ctx.canvas(W, H).clear(t.bg);
                const d = car.data();
                const now = Date.now();
                const dt = Math.min(0.1, Math.max(0.001, (now - lastCooldownTick) / 1000));
                lastCooldownTick = now;

                const isDemo = (!diag || !diag.ready) || settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && d.demo);
                if (isDemo) {
                    updateDemoState(d, dt);
                }

                const rpm = G.isNum(d.rpm) ? d.rpm : 0;
                const iceTorque = G.isNum(d.torque) && d.torque > 0 ? d.torque : 0;
                const iceKw = (iceTorque * rpm) / 9549;
                const iceHp = iceKw * 1.35962;

                // 2. Real BMS derating calculation from SME battery limits (NO hardcoded 30% rule!)
                const soc = G.isNum(liveDiag.soc) ? liveDiag.soc : 60;
                let derateRatio = 1.0;

                if (liveDiag.bmsRealData && liveDiag.hvVolts > 180 && liveDiag.dischargeLimitA > 10) {
                    // Physical max discharge power allowed by BMW BMS (kW)
                    const maxBmsKw = (liveDiag.hvVolts * liveDiag.dischargeLimitA) / 1000;
                    // Full 109 HP (80 kW mechanical) requires ~84 kW electrical from the battery
                    if (maxBmsKw < 84.0) {
                        derateRatio = G.clamp(maxBmsKw / 84.0, 0.15, 1.0);
                    } else {
                        derateRatio = 1.0;
                    }
                } else {
                    // Fallback when SME is still connecting or idle:
                    // We only assume mild derating when SoC is genuinely depleted (< 15%)
                    if (soc < 15) {
                        derateRatio = G.clamp(0.40 + (soc / 15) * 0.60, 0.40, 1.0);
                    } else {
                        derateRatio = 1.0;
                    }
                }
                liveDiag.derateRatio = derateRatio;

                const evMaxHp = Math.round(SPEC.evMaxHp * derateRatio);
                const evMaxNm = Math.round(SPEC.evMaxNm * derateRatio);
                const lostHp = SPEC.evMaxHp - evMaxHp;
                const lostNm = SPEC.evMaxNm - evMaxNm;

                // 3. Real Electric Motor Power and Torque from HV battery current
                let evHp = 0;
                let evTorque = 0;
                if (liveDiag.hvAmps > 2.5 && liveDiag.hvVolts > 180) {
                    // Real electrical power flowing from battery to motor (inverter + e-motor efficiency ~91%)
                    const realEvKw = (liveDiag.hvVolts * liveDiag.hvAmps * 0.91) / 1000;
                    evHp = G.clamp(realEvKw * 1.35962, 0, evMaxHp);
                    if (rpm > 200) {
                        evTorque = G.clamp((realEvKw * 9549) / rpm, 0, evMaxNm);
                    } else {
                        evTorque = G.clamp((evHp / (SPEC.evMaxHp || 1)) * SPEC.evMaxNm, 0, evMaxNm);
                    }
                } else {
                    // Dynamic demand estimation when current sensor is settling
                    const accelPct = G.clamp((rpm / 4500) * (iceTorque / 350 || 0.5), 0, 1);
                    evHp = (rpm > 100 || (d.speed || 0) > 0) ? (evMaxHp * accelPct) : 0;
                    evTorque = (rpm > 100 || (d.speed || 0) > 0) ? (evMaxNm * accelPct) : 0;
                }

                const systemHp = Math.round(iceHp + evHp);

                if (liveDiag.boostActual > 1.0 || (iceTorque > 350 && rpm > 3200)) {
                    liveDiag.wot = true;
                    liveDiag.peakBoost = Math.max(liveDiag.peakBoost, liveDiag.boostActual);
                    liveDiag.peakIat = Math.max(liveDiag.peakIat, liveDiag.iat);
                    for (let c = 0; c < 4; c++) {
                        liveDiag.peakCorr[c] = Math.min(liveDiag.peakCorr[c], liveDiag.cylCorr[c]);
                    }
                }

                const oilTemp = G.isNum(d.oil) ? d.oil : 88;
                const coolantTemp = G.isNum(d.coolant) ? d.coolant : 92;
                const isHardDriving = (liveDiag.boostActual > 1.0) || (rpm > 3900 && iceTorque > 300) || (oilTemp > 102);

                if (isHardDriving) {
                    cooldownRemaining = settings.get('cooldownSec') || 90;
                } else if (cooldownRemaining > 0) {
                    const isGentle = (rpm < 2200 && liveDiag.boostActual < 0.25);
                    if (isGentle) {
                        cooldownRemaining = Math.max(0, cooldownRemaining - dt);
                    }
                }

                const oilOk = (oilTemp >= 85 && oilTemp <= 108);
                const iatOk = (liveDiag.iat < 45);
                const bmsOk = (derateRatio >= 0.98);
                const ready100_200 = oilOk && iatOk && bmsOk;

                const badges = [];
                if (isDemo) badges.push({ text: 'DEMO', color: 'accent' });
                if (cooldownRemaining > 0) badges.push({ text: 'COOLDOWN ' + Math.ceil(cooldownRemaining) + 's', color: 'warn' });
                if (ready100_200) badges.push({ text: '420 KM READY', color: GO });

                G.frame(cv, t, TABS, activeTab, badges);

                if (activeTab === 0) {
                    renderTab1_XtraBoostGuard(cv, t, {
                        rpm, iceHp, iceTorque, evHp, evTorque, evMaxHp, evMaxNm,
                        lostHp, lostNm, derateRatio, soc, systemHp, ready100_200,
                        oilOk, iatOk, bmsOk, oilTemp
                    });
                } else if (activeTab === 1) {
                    renderTab2_WarmupTurbo(cv, t, {
                        oilTemp, coolantTemp, rpm, isHardDriving, cooldownRemaining
                    });
                } else if (activeTab === 2) {
                    renderTab3_ServiceTracker(cv, t);
                }

                // CRITICAL: Hand drawn canvas to display/HMI so it renders on screen!
                return ui.image('MAIN_GFX', cv);
            } catch (renderErr) {
                fatalError = renderErr;
                fatalStage = 'PETLA RENDEROWANIA (RENDER LOOP)';
                log.error('FATAL RENDER ERROR: ' + (renderErr && renderErr.stack || renderErr));
                const cv = ctx.canvas(W, H);
                drawCrashScreen(cv, ctx.theme(), fatalError, fatalStage);
                return ui.image('MAIN_GFX', cv);
            }
        }

        // Paced at display vsync (60 fps) with GPU renderer; 6 fps software fallback
        ctx.loop('MAIN', 6, render);

        // Render first frame immediately at startup
        updateBarButtons();
        render().then(() => log.info('first frame rendered successfully')).catch((e) => {
            log.error('first render error', e);
            fatalError = e;
            fatalStage = 'PIERWSZA KLATKA (FIRST RENDER)';
            const cv = ctx.canvas(W, H);
            drawCrashScreen(cv, ctx.theme(), fatalError, fatalStage);
            ui.image('MAIN_GFX', cv);
        });

        /* =========================================================================
         * TAB 1: XTRABOOST GUARD (Dual Power Split, BMS Detector, 100-200, Fuel)
         * ========================================================================= */
        function renderTab1_XtraBoostGuard(cv, t, p) {
            const colW = 500;
            const topY = 46;
            const h = 466;

            G.panel(cv, t, 16, topY, colW, h, 'MOC SILNIKOW (DUAL POWER SPLIT)');

            cv.text('SILNIK B48 (SPALINOWY - STAGE 1)', 36, topY + 68, 20, t.text, { font: 'bold' });
            G.bar(cv, t, 36, topY + 76, colW - 40, 60, {
                label: 'MOC B48',
                unit: 'KM',
                value: p.iceHp,
                min: 0,
                max: 340,
                decimals: 0,
                color: BLUE,
                peak: Math.max(p.iceHp, SPEC.iceMaxHp * 0.95),
                zones: [{ from: 300, to: 340, color: CRIT }]
            });

            G.bar(cv, t, 36, topY + 154, colW - 40, 60, {
                label: 'MOMENT B48',
                unit: 'Nm',
                value: p.iceTorque,
                min: 0,
                max: 500,
                decimals: 0,
                color: BLUE,
                peak: Math.max(p.iceTorque, SPEC.iceMaxNm * 0.95),
                zones: [{ from: 430, to: 500, color: CRIT }]
            });

            cv.fillRect(36, topY + 236, colW - 40, 1, withAlpha('#ffffff', 0.12));
            cv.text('SILNIK ELEKTRYCZNY (EME - XTRABOOST)', 36, topY + 264, 20, p.derateRatio < 0.98 ? WARN : M_CYAN, { font: 'bold' });

            G.bar(cv, t, 36, topY + 272, colW - 40, 60, {
                label: 'MOC ELEKTRYCZNA',
                unit: 'KM',
                value: p.evHp,
                min: 0,
                max: 120,
                decimals: 0,
                color: p.derateRatio < 0.98 ? WARN : M_CYAN,
                peak: p.evMaxHp
            });

            G.bar(cv, t, 36, topY + 350, colW - 40, 60, {
                label: 'MOMENT ELEKTRYCZNY',
                unit: 'Nm',
                value: p.evTorque,
                min: 0,
                max: 300,
                decimals: 0,
                color: p.derateRatio < 0.98 ? WARN : M_CYAN,
                peak: p.evMaxNm
            });

            if (p.derateRatio < 0.98) {
                cv.roundRect(36, topY + 418, colW - 40, 42, 6, withAlpha(WARN, 0.22));
                cv.strokeRoundRect(36, topY + 418, colW - 40, 42, 6, 1.5, WARN);
                const limitTxt = liveDiag.bmsRealData
                    ? 'BMS LIMIT: -' + p.lostHp + ' KM / -' + p.lostNm + ' Nm (BMS ' + liveDiag.dischargeLimitA.toFixed(0) + 'A | SoC ' + p.soc.toFixed(0) + '%)'
                    : 'BMS LIMIT: -' + p.lostHp + ' KM / -' + p.lostNm + ' Nm (SoC ' + p.soc.toFixed(0) + '%)';
                cv.text(limitTxt, 36 + (colW - 40) / 2, topY + 444, 16, WARN, { align: 'center', font: 'bold' });
            } else {
                cv.roundRect(36, topY + 418, colW - 40, 42, 6, withAlpha(GO, 0.15));
                cv.strokeRoundRect(36, topY + 418, colW - 40, 42, 6, 1.5, withAlpha(GO, 0.6));
                const okTxt = liveDiag.bmsRealData
                    ? 'XTRABOOST 100% (109 KM / 265 Nm) | BMS: ' + liveDiag.dischargeLimitA.toFixed(0) + 'A | SoC: ' + p.soc.toFixed(0) + '%'
                    : 'XTRABOOST 100% (109 KM / 265 Nm OK) | SoC: ' + p.soc.toFixed(0) + '%';
                cv.text(okTxt, 36 + (colW - 40) / 2, topY + 444, 16, GO, { align: 'center', font: 'bold' });
            }

            const midX = 534;
            const midW = 532;
            G.panel(cv, t, midX, topY, midW, h, 'MOC SYSTEMOWA & 100-200 READY');

            cv.text('MOC SYSTEMOWA (HYBRYDA B48 + EME)', midX + midW / 2, topY + 68, 20, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
            const pwrStr = String(p.systemHp);
            const pw = cv.text(pwrStr, midX + midW / 2 - 32, topY + 145, 84, p.systemHp >= 400 ? GO : t.text, { align: 'center', font: 'num' });
            cv.text('KM', midX + midW / 2 + pw / 2 + 10, topY + 138, 32, t.dim, { font: 'bold' });

            G.bar(cv, t, midX + 30, topY + 158, midW - 60, 48, {
                label: '',
                head: false,
                value: p.systemHp,
                min: 0,
                max: 450,
                color: GO,
                zones: [{ from: 410, to: 450, color: GO }]
            });

            cv.fillRect(midX + 30, topY + 224, midW - 60, 1, withAlpha('#ffffff', 0.12));
            cv.text('STATUS GOTOWOSCI DO POMIARU 100-200 KM/H', midX + midW / 2, topY + 252, 20, t.text, { align: 'center', font: 'bold' });

            const rCardY = topY + 268;
            const rCardH = 188;
            if (p.ready100_200) {
                cv.roundRect(midX + 30, rCardY, midW - 60, rCardH, 10, withAlpha(GO, 0.22));
                cv.strokeRoundRect(midX + 30, rCardY, midW - 60, rCardH, 10, 2, GO);
                cv.text('GOTOWY - 420 KM', midX + midW / 2, rCardY + 48, 38, GO, { align: 'center', font: 'bold', spacing: 2 });
                cv.text('(100-200 READY - PELNA MOC)', midX + midW / 2, rCardY + 84, 22, GO, { align: 'center', font: 'bold' });

                cv.fillRect(midX + 60, rCardY + 104, midW - 120, 1, withAlpha(GO, 0.3));
                cv.text('✓ Temp. oleju: ' + p.oilTemp.toFixed(0) + '°C (85-108°C)', midX + 60, rCardY + 130, 20, t.text);
                cv.text('✓ Temp. dolotu (IAT): ' + liveDiag.iat.toFixed(0) + '°C (< 45°C)', midX + 60, rCardY + 154, 20, t.text);
                cv.text('✓ Bateria XtraBoost: 100% mocy elektryka', midX + 60, rCardY + 178, 20, t.text);
            } else {
                const cardCol = (!p.oilOk && p.oilTemp < 60) ? CRIT : WARN;
                cv.roundRect(midX + 30, rCardY, midW - 60, rCardH, 10, withAlpha(cardCol, 0.16));
                cv.strokeRoundRect(midX + 30, rCardY, midW - 60, rCardH, 10, 2, cardCol);
                cv.text('BLOKADA POMIARU 100-200', midX + midW / 2, rCardY + 42, 30, cardCol, { align: 'center', font: 'bold', spacing: 1.5 });

                let by = rCardY + 82;
                if (!p.oilOk) {
                    const why = p.oilTemp < 85 ? 'Zimny olej (' + p.oilTemp.toFixed(0) + '°C < 85°C)' : 'Za goracy olej (' + p.oilTemp.toFixed(0) + '°C > 108°C)';
                    cv.text('✗ ' + why, midX + 50, by, 21, CRIT, { font: 'bold' });
                    by += 28;
                }
                if (!p.iatOk) {
                    cv.text('✗ Za wysoka IAT (' + liveDiag.iat.toFixed(0) + '°C >= 45°C)', midX + 50, by, 21, WARN, { font: 'bold' });
                    by += 28;
                }
                if (!p.bmsOk) {
                    cv.text('✗ BMS obcina moc elektryka (SoC ' + p.soc.toFixed(0) + '%)', midX + 50, by, 21, WARN, { font: 'bold' });
                    by += 28;
                }
            }

            const rightX = 1084;
            const rightW = 500;
            G.panel(cv, t, rightX, topY, rightW, h, 'MONITOR PALIWA & ZAPLONU (0x12 DME)');

            G.bar(cv, t, rightX + 24, topY + 68, rightW - 40, 60, {
                label: 'DOLADOWANIE (CEL ' + SPEC.targetBoostBar.toFixed(1) + ' BAR)',
                unit: 'bar',
                value: liveDiag.boostActual,
                min: 0,
                max: 2.0,
                decimals: 2,
                color: BLUE,
                peak: liveDiag.peakBoost,
                zones: [{ from: 1.45, to: 1.65, color: GO }, { from: 1.65, to: 2.0, color: CRIT }]
            });

            G.bar(cv, t, rightX + 24, topY + 146, rightW - 40, 60, {
                label: 'TEMP. W DOLOCIE (IAT)',
                unit: '°C',
                value: liveDiag.iat,
                min: 10,
                max: 60,
                decimals: 0,
                color: liveDiag.iat >= 45 ? CRIT : liveDiag.iat >= 38 ? WARN : GO,
                peak: liveDiag.peakIat,
                zones: [{ from: 45, to: 60, color: CRIT }]
            });

            cv.fillRect(rightX + 24, topY + 226, rightW - 40, 1, withAlpha('#ffffff', 0.12));
            cv.text('KAT ZAPLONU: ' + liveDiag.baseTiming.toFixed(1) + '°CA (CYLINDRY 1-4 KOREKTY)', rightX + 24, topY + 254, 19, t.text, { font: 'bold' });

            const thresh = settings.get('knockThreshold') || -3.0;
            let knockDetected = false;

            const boxW = (rightW - 40 - 24) / 4;
            for (let c = 0; c < 4; c++) {
                const bx = rightX + 24 + c * (boxW + 8);
                const by = topY + 268;
                const corr = liveDiag.cylCorr[c];
                const pCorr = liveDiag.peakCorr[c];
                const bad = pCorr <= thresh;
                if (bad) knockDetected = true;

                cv.roundRect(bx, by, boxW, 76, 6, withAlpha(bad ? CRIT : '#ffffff', bad ? 0.22 : 0.06));
                cv.strokeRoundRect(bx, by, boxW, 76, 6, 1.5, bad ? CRIT : withAlpha('#ffffff', 0.2));

                cv.text('CYL ' + (c + 1), bx + boxW / 2, by + 22, 17, t.dim, { align: 'center', font: 'bold' });
                cv.text((corr > 0 ? '+' : '') + corr.toFixed(1) + '°', bx + boxW / 2, by + 46, 21, bad ? CRIT : t.text, { align: 'center', font: 'num' });
                cv.text('Peak ' + (pCorr > 0 ? '+' : '') + pCorr.toFixed(1) + '°', bx + boxW / 2, by + 66, 15, bad ? CRIT : t.dim, { align: 'center' });
            }

            const verdictY = topY + 360;
            if (knockDetected) {
                cv.roundRect(rightX + 24, verdictY, rightW - 40, 90, 8, withAlpha(CRIT, 0.22));
                cv.strokeRoundRect(rightX + 24, verdictY, rightW - 40, 90, 8, 2, CRIT);
                cv.text('WYKRYTO KOREKTE < ' + thresh.toFixed(1) + '° (STUKOWE)', rightX + rightW / 2, verdictY + 28, 20, CRIT, { align: 'center', font: 'bold' });
                cv.text('Paliwo PB95 / za niska liczba oktanowa!', rightX + rightW / 2, verdictY + 52, 18, t.text, { align: 'center' });
                cv.text('Zalecane: PB98 + dodatek Millers EcoMax', rightX + rightW / 2, verdictY + 76, 18, GO, { align: 'center', font: 'bold' });
            } else {
                cv.roundRect(rightX + 24, verdictY, rightW - 40, 90, 8, withAlpha(GO, 0.15));
                cv.strokeRoundRect(rightX + 24, verdictY, rightW - 40, 90, 8, 1.5, withAlpha(GO, 0.6));
                cv.text('ZAPLON STABILNY - PALIWO PB98 / ECOMAX OK', rightX + rightW / 2, verdictY + 32, 19, GO, { align: 'center', font: 'bold' });
                cv.text('Brak niebezpiecznych korekt zaplonu na WOT', rightX + rightW / 2, verdictY + 58, 17, t.text, { align: 'center' });
                cv.text('Dolny przycisk: Reset Peak po kolejnym pullu', rightX + rightW / 2, verdictY + 78, 15, t.dim, { align: 'center' });
            }
        }

        /* =========================================================================
         * TAB 2: WARMUP & TURBO (Ochrona Zimnego B48, Dynamiczny Limit, Cooldown)
         * ========================================================================= */
        function renderTab2_WarmupTurbo(cv, t, p) {
            const colW = 764;
            const topY = 46;
            const h = 466;

            G.panel(cv, t, 16, topY, colW, h, 'ROZGRZEWANIE SILNIKA B48 & HYBRID COLD-START GUARD');

            const gaugeW = (colW - 60) / 2;
            G.panel(cv, t, 36, topY + 58, gaugeW, 134, 'TEMPERATURA OLEJU');
            const oilCol = p.oilTemp < 50 ? M_CYAN : p.oilTemp < 80 ? WARN : p.oilTemp > 108 ? CRIT : GO;
            cv.text(p.oilTemp.toFixed(0) + ' °C', 36 + gaugeW / 2, topY + 130, 48, oilCol, { align: 'center', font: 'num' });
            const oilStateTxt = p.oilTemp < 50 ? 'ZIMNY' : p.oilTemp < 80 ? 'ROZGRZEWANIE' : 'ROBOCZA';
            cv.text(oilStateTxt, 36 + gaugeW / 2, topY + 166, 20, oilCol, { align: 'center', font: 'bold' });

            G.panel(cv, t, 36 + gaugeW + 20, topY + 58, gaugeW, 134, 'PLYN CHLODNICZY');
            const cCol = p.coolantTemp < 70 ? M_CYAN : GO;
            cv.text(p.coolantTemp.toFixed(0) + ' °C', 36 + gaugeW + 20 + gaugeW / 2, topY + 130, 48, cCol, { align: 'center', font: 'num' });
            cv.text(p.coolantTemp >= 80 ? 'ROBOCZA' : 'ROZGRZEWANIE', 36 + gaugeW + 20 + gaugeW / 2, topY + 166, 20, cCol, { align: 'center', font: 'bold' });

            let modeTitle, modeCol, safeRpm, safeBoost;
            if (p.oilTemp < 50) {
                modeTitle = 'TRYB ZIMNY (B48 COLD GUARD)';
                modeCol = M_CYAN;
                safeRpm = 2500;
                safeBoost = 0.0;
            } else if (p.oilTemp < 80) {
                modeTitle = 'TRYB ROZGRZEWANIA';
                modeCol = WARN;
                const ratio = (p.oilTemp - 50) / 30;
                safeRpm = Math.round(2800 + (4200 - 2800) * ratio);
                safeBoost = 0.60;
            } else {
                modeTitle = 'TEMPERATURA ROBOCZA (STAGE 1 ODBLOKOWANY)';
                modeCol = GO;
                safeRpm = 6500;
                safeBoost = 1.50;
            }

            const cardY = topY + 210;
            cv.roundRect(36, cardY, colW - 40, 110, 8, withAlpha(modeCol, 0.18));
            cv.strokeRoundRect(36, cardY, colW - 40, 110, 8, 2, modeCol);

            cv.text(modeTitle, 56, cardY + 34, 24, modeCol, { font: 'bold', spacing: 1.5 });
            cv.text('BEZPIECZNY PUAP OBROTOW: ' + safeRpm + ' RPM', 56, cardY + 68, 22, t.text, { font: 'bold' });
            cv.text('MAX DOZWOLONE DOLADOWANIE: ' + safeBoost.toFixed(1) + ' bar', 56, cardY + 96, 22, t.text, { font: 'bold' });

            const overrev = (p.oilTemp < 50 && p.rpm > 2500);
            if (overrev) {
                cv.roundRect(36, topY + 338, colW - 40, 110, 8, withAlpha(CRIT, 0.3));
                cv.strokeRoundRect(36, topY + 338, colW - 40, 110, 8, 2.5, CRIT);
                cv.text('UWAGA: ZIMNY SILNIK! OGRANICZ GAZ!', 36 + (colW - 40) / 2, topY + 376, 28, CRIT, { align: 'center', font: 'bold', spacing: 2 });
                cv.text('B48 uruchomiony w hybrydzie przy zimnym oleju. Zwolnij obroty ponizej 2500 RPM!',
                    36 + (colW - 40) / 2, topY + 414, 20, t.text, { align: 'center' });
            } else {
                G.bar(cv, t, 36, topY + 344, colW - 40, 60, {
                    label: 'OBROTY SILNIKA B48',
                    unit: 'RPM',
                    value: p.rpm,
                    min: 0,
                    max: 7000,
                    decimals: 0,
                    color: p.rpm > safeRpm ? CRIT : BLUE,
                    peak: safeRpm
                });
                cv.text('Hybryda 530e uruchamia B48 nagle przy wyprzedzaniu - kontroluj limit!', 56, topY + 434, 18, t.dim);
            }

            const rightX = 820;
            G.panel(cv, t, rightX, topY, colW, h, 'STRAZNIK CHLODZENIA TURBINY (PHEV S/S GUARD)');

            const coolActive = (p.cooldownRemaining > 0);
            const coolH = 390;

            if (coolActive) {
                cv.roundRect(rightX + 24, topY + 58, colW - 48, coolH, 12, withAlpha(CRIT, 0.22));
                cv.strokeRoundRect(rightX + 24, topY + 58, colW - 48, coolH, 12, 2.5, CRIT);

                cv.text('NIE GAS B48!', rightX + colW / 2, topY + 112, 44, CRIT, { align: 'center', font: 'bold', spacing: 3 });
                cv.text('Wlacz tryb SPORT lub przesun dzwignie w S,', rightX + colW / 2, topY + 158, 26, t.text, { align: 'center', font: 'bold' });
                cv.text('aby hybryda nie wylaczyla obiegu oleju na postoju!', rightX + colW / 2, topY + 194, 26, WARN, { align: 'center', font: 'bold' });

                cv.fillRect(rightX + 60, topY + 224, colW - 120, 1, withAlpha(CRIT, 0.3));
                cv.text('POZOSTALO CHLODZENIA TURBINY', rightX + colW / 2, topY + 258, 22, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });

                const cdStr = String(Math.ceil(p.cooldownRemaining));
                const cdw = cv.text(cdStr, rightX + colW / 2 - 20, topY + 346, 96, CRIT, { align: 'center', font: 'num' });
                cv.text('sekund', rightX + colW / 2 + cdw / 2 + 15, topY + 338, 28, t.dim);

                const totalCd = settings.get('cooldownSec') || 90;
                const progress = G.clamp(1.0 - (p.cooldownRemaining / totalCd), 0, 1);
                cv.fillRect(rightX + 60, topY + 380, colW - 120, 14, withAlpha('#ffffff', 0.15));
                cv.fillRect(rightX + 60, topY + 380, Math.round((colW - 120) * progress), 14, GO);
                cv.text('Postoj z pracujacym silnikiem lub spokojna jazda', rightX + colW / 2, topY + 424, 19, t.dim, { align: 'center' });
            } else {
                cv.roundRect(rightX + 24, topY + 58, colW - 48, coolH, 12, withAlpha(GO, 0.15));
                cv.strokeRoundRect(rightX + 24, topY + 58, colW - 48, coolH, 12, 1.5, withAlpha(GO, 0.6));

                cv.text('TURBINA SCHLODZONA', rightX + colW / 2, topY + 120, 36, GO, { align: 'center', font: 'bold', spacing: 2 });
                cv.text('Temperatura turbosprezarki i oleju w normie.', rightX + colW / 2, topY + 168, 24, t.text, { align: 'center' });
                cv.text('Mozna bezpiecznie wylaczyc silnik lub przejsc w tryb EV.', rightX + colW / 2, topY + 208, 22, GO, { align: 'center' });

                cv.fillRect(rightX + 60, topY + 250, colW - 120, 1, withAlpha('#ffffff', 0.12));
                cv.text('WARUNKI AKTYWACJI STRAZNIKA:', rightX + 60, topY + 288, 20, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text('• Doladowanie B48 > 1.0 bar (Stage 1 Boost)', rightX + 60, topY + 322, 21, t.text);
                cv.text('• Obroty > 3900 RPM i moment > 300 Nm', rightX + 60, topY + 356, 21, t.text);
                cv.text('• Temperatura oleju > 102°C', rightX + 60, topY + 390, 21, t.text);
                cv.text('Automatyczny timer 90s zapobiega naglemu odcieciu smarowania w PHEV.', rightX + 60, topY + 426, 18, t.dim);
            }
        }

        /* =========================================================================
         * TAB 3: SERVICE TRACKER (Inteligentny Licznik Przebiegu B48 vs EV)
         * ========================================================================= */
        function renderTab3_ServiceTracker(cv, t) {
            const topY = 46;
            const h = 466;

            const leftW = 1040;
            G.panel(cv, t, 16, topY, leftW, h, 'INTELIGENTNY LICZNIK SERWISOWY (B48 OPERATING KM)');

            cv.text('INTERWALY PRACY SILNIKA SPALINOWEGO (ZLICZANE GDY RPM > 0)', 36, topY + 68, 19, t.dim, { font: 'bold', spacing: 1.5 });

            const itemY0 = topY + 86;
            const itemH = 104;

            serviceState.intervals.forEach((it, idx) => {
                const iy = itemY0 + idx * (itemH + 12);
                const isSelected = (idx === selectedServiceIdx);
                const isArmed = isSelected && (Date.now() < serviceConfirmUntil);

                const current = it.currentKm || 0;
                const limit = it.limitKm || 10000;
                const remaining = Math.max(0, limit - current);
                const wearPct = G.clamp(Math.round((current / limit) * 100), 0, 100);

                let pCol = GO;
                if (wearPct >= 90) pCol = CRIT;
                else if (wearPct >= 70) pCol = WARN;

                cv.roundRect(36, iy, leftW - 40, itemH, 8, withAlpha(isSelected ? BLUE : '#ffffff', isSelected ? 0.20 : 0.05));
                cv.strokeRoundRect(36, iy, leftW - 40, itemH, 8, isSelected ? 2 : 1, isSelected ? (isArmed ? CRIT : BLUE) : withAlpha('#ffffff', 0.15));

                const titleStr = it.name;
                cv.text(titleStr, 56, iy + 30, 24, t.text, { font: 'bold' });
                cv.text(it.spec || '', 56, iy + 52, 17, t.dim);

                const numStr = current.toFixed(0) + ' / ' + limit + ' km B48';
                cv.text(numStr, leftW - 24, iy + 30, 24, t.text, { align: 'right', font: 'num' });
                cv.text('Pozostalo: ' + remaining.toFixed(0) + ' km (' + wearPct + '% zuzycia)', leftW - 24, iy + 52, 18, pCol, { align: 'right', font: 'bold' });

                const barX = 56;
                const barY = iy + 68;
                const barW = leftW - 40 - 40;
                const barH = 16;
                cv.roundRect(barX, barY, barW, barH, 4, withAlpha('#ffffff', 0.15));
                const fillW = Math.round(barW * (wearPct / 100));
                if (fillW > 0) {
                    cv.roundRect(barX, barY, fillW, barH, 4, pCol);
                }

                if (isSelected) {
                    cv.text('►', 40, iy + 42, 20, isArmed ? CRIT : BLUE);
                }
            });

            const noteY = topY + 444;
            const isArmed = Date.now() < serviceConfirmUntil;
            if (isArmed) {
                const it = serviceState.intervals[selectedServiceIdx];
                cv.text('POTWIERDZ RESET DLA: ' + (it ? it.name : '') + ' (KLIKNIJ DOLNY PRZYCISK W CIAGU 5s)',
                    leftW / 2, noteY, 20, CRIT, { align: 'center', font: 'bold' });
            } else {
                cv.text('Wskaz pozycje dotykiem na ekranie | Dolny przycisk: Reset z podwojnym potwierdzeniem',
                    leftW / 2, noteY, 18, t.dim, { align: 'center' });
            }

            const rightX = 1076;
            const rightW = 508;
            G.panel(cv, t, rightX, topY, rightW, h, 'BILANS PRZEBIEGU HYBRYDY (PHEV)');

            const totalIce = serviceState.totalIceKm || 0;
            const totalEv = serviceState.totalEvKm || 0;
            const totalTracked = totalIce + totalEv;
            const evPct = totalTracked > 0 ? Math.round((totalEv / totalTracked) * 100) : 0;
            const totalOdo = (serviceState.baseOdo || 113000) + totalTracked;

            cv.text('CALKOWITY PRZEBIEG AUTA (ODOMETER)', rightX + 24, topY + 70, 19, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(totalOdo.toFixed(0) + ' km', rightX + 24, topY + 116, 42, t.text, { font: 'num' });

            cv.fillRect(rightX + 24, topY + 138, rightW - 48, 1, withAlpha('#ffffff', 0.12));

            cv.text('ROZDZIAL PRZEBIEGU W TYM CYKLU:', rightX + 24, topY + 168, 19, t.dim, { font: 'bold', spacing: 1.5 });

            cv.roundRect(rightX + 24, topY + 184, rightW - 48, 64, 8, withAlpha(BLUE, 0.15));
            cv.strokeRoundRect(rightX + 24, topY + 184, rightW - 48, 64, 8, 1, withAlpha(BLUE, 0.6));
            cv.text('PRACA SILNIKA B48 (RPM > 0):', rightX + 44, topY + 212, 19, t.text, { font: 'bold' });
            cv.text(totalIce.toFixed(1) + ' km', rightX + rightW - 48, topY + 224, 26, BLUE, { align: 'right', font: 'num' });

            cv.roundRect(rightX + 24, topY + 260, rightW - 48, 64, 8, withAlpha(GO, 0.15));
            cv.strokeRoundRect(rightX + 24, topY + 260, rightW - 48, 64, 8, 1, withAlpha(GO, 0.6));
            cv.text('JAZDA BEZEMISYJNA EV (RPM == 0):', rightX + 44, topY + 288, 19, t.text, { font: 'bold' });
            cv.text(totalEv.toFixed(1) + ' km', rightX + rightW - 48, topY + 300, 26, GO, { align: 'right', font: 'num' });

            cv.text('UDZIAL JAZDY NA PRADZIE: ' + evPct + '%', rightX + 24, topY + 358, 20, GO, { font: 'bold' });
            cv.roundRect(rightX + 24, topY + 372, rightW - 48, 18, 4, withAlpha('#ffffff', 0.15));
            cv.roundRect(rightX + 24, topY + 372, Math.round((rightW - 48) * (evPct / 100)), 18, 4, GO);

            cv.text('Olej, filtr i swiece zuzywaja sie tylko wtedy,', rightX + 24, topY + 420, 17, t.dim);
            cv.text('gdy silnik B48 fizycznie pracuje. Prad nie zuzywa B48!', rightX + 24, topY + 444, 17, GO, { font: 'bold' });
        }
    } catch (startErr) {
        fatalError = startErr;
        fatalStage = 'INICJALIZACJA (STARTUP)';
        log.error('FATAL STARTUP CRASH: ' + (startErr && startErr.stack || startErr));
        const emergencyRender = () => {
            const cv = ctx.canvas(W, H);
            drawCrashScreen(cv, ctx.theme(), fatalError, fatalStage);
            return ui.image('MAIN_GFX', cv);
        };
        ctx.loop('MAIN', 2, emergencyRender);
        emergencyRender().catch((e) => log.error('emergency render error: ' + e));
    }
}
});
