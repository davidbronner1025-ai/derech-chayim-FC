// sim_engine.js
// Advanced Telemetry & Headless Monte Carlo Simulator

window.simTelemetry = {
  heatmap: Array(10).fill(0).map(() => Array(10).fill(0)),
  xG: { user: 0, ai: 0 },
  shots: { user: 0, ai: 0 }
};

window.logHeatmapEvent = function(x, z) {
  // PITCH_W = 110, PITCH_H = 70. Normalize to 0-9 index.
  const hx = Math.max(0, Math.min(9, Math.floor((x + 55) / 11))); 
  const hz = Math.max(0, Math.min(9, Math.floor((z + 35) / 7)));  
  window.simTelemetry.heatmap[hx][hz]++;
};

window.simulateMonteCarlo = async function(matchesPerCombo = 100) {
    const difficulties = ['EASY', 'NORMAL', 'HARD', 'EXTREME'];
    console.log(`Starting Monte Carlo Matrix (${matchesPerCombo} matches per combo)...`);
    
    const results = {};
    window.isHeadless = true;
    
    // Sandbox: Disable DOM updates and Sounds to prevent crashes and lagging
    const _origGetElementById = document.getElementById;
    const dummyEl = { style: {}, textContent: '', innerHTML: '', onclick: null, addEventListener: ()=>{} };
    document.getElementById = function(id) { return dummyEl; };
    
    const _origPlaySound = window.playSound;
    window.playSound = function(){};
    
    const _origPlayRealSound = window.playRealSound;
    window.playRealSound = function(){};

    const _origShowMessage = window.showMessage;
    window.showMessage = function(){};
    
    const _origCreateTackleParticles = window.createTackleParticles;
    window.createTackleParticles = function(){};
    
    const _origAppendChild = document.body.appendChild;
    document.body.appendChild = function(node) {
        if (node && node.id === 'endScreen') return; // Do not append end screens
        if (node && node.id === 'celebUI') return; // Do not append celeb UI
        return _origAppendChild.call(document.body, node);
    };
    
    const _origConsoleLog = console.log;
    console.log = function(...args) {
        if (args[0] && typeof args[0] === 'string' && args[0].includes('MATCH TELEMETRY')) return;
        _origConsoleLog.apply(console, args);
    };
    
    // Bypass timeouts that would hang the game during synchronous headless loops
    // But we MUST save the original to yield to the browser and prevent crashes!
    const _origSetTimeout = window.setTimeout;
    window.setTimeout = function(fn, delay) {
        if (typeof fn === 'function') fn();
        return 0;
    };
    
    for (let homeDiff of difficulties) {
       for (let awayDiff of difficulties) {
           let comboKey = `${homeDiff}_vs_${awayDiff}`;
           results[comboKey] = { homeWins: 0, awayWins: 0, draws: 0, homeGoals: 0, awayGoals: 0, shots: 0, passes: 0 };
           console.log(`Simulating ${comboKey}...`);
           
           let safeMatches = Math.min(matchesPerCombo, 20); // Clamp to 20 to prevent accidental OS freeze
           for (let m=0; m<safeMatches; m++) {
               window.simHomeDiff = homeDiff;
               window.simAwayDiff = awayDiff;
               
               // Heavy Reset
               window.isCpuVsCpu = true; // Force AI vs AI mode!
               window.headlessShots = 0; window.headlessPasses = 0;
               if (!window._origAiShoot) window._origAiShoot = window.aiShoot;
               window.aiShoot = function(p) { window.headlessShots++; window._origAiShoot(p); };
               if (!window._origAiPass) window._origAiPass = window.aiPass;
               window.aiPass = function(p, t) { window.headlessPasses++; return window._origAiPass(p, t); };
               
               if (window.forceGameReset) {
                   window.forceGameReset();
               } else {
                   // Fallback
                   if (window.ball) window.ball.position.set(0, 0.11, 0);
                   window.ballOwner = null; window.prevBallOwner = null; 
                   window.isPlaying = true; window.goalScored = false;
               }
               
               if (window.telemetryData) {
                   window.telemetryData.possession.user = { duration:0, passes:0, touches:0 };
                   window.telemetryData.possession.ai = { duration:0, passes:0, touches:0 };
               }
               
               // Match Loop (11250 iterations of 0.016s delta ≈ 90 in-game minutes)
               // (matchTime += dt * 18, so 0.288 time per tick. 90*60=5400. 5400/0.288 = 18750)
               for (let it=0; it<18750; it++) {
                   if (window.update) window.update(0.016);
                   
                   // If match naturally ended (isPlaying became false via fullTime), we can break early
                   if (!window.isPlaying && !window.goalScored) {
                       break;
                   }
                   
                   // YIELD to browser Event Loop every 500 frames to ensure zero UI freezing!
                   if (it % 500 === 0) {
                       await new Promise(resolve => _origSetTimeout(resolve, 0));
                   }
               }
               
               let scores = window.getGameScores ? window.getGameScores() : {a:0, b:0};
               let gu = scores.a, ga = scores.b;
               results[comboKey].homeGoals += gu;
               results[comboKey].awayGoals += ga;
               results[comboKey].shots += window.headlessShots;
               results[comboKey].passes += window.headlessPasses;
               if(gu > ga) results[comboKey].homeWins++;
               else if(ga > gu) results[comboKey].awayWins++;
               else results[comboKey].draws++;
           }
           
           // Yield to prevent browser "Unresponsive" dialog
           await new Promise(resolve => setTimeout(resolve, 50)); 
       }
    }
    
    // Restore Sandboxed Functions
    document.getElementById = _origGetElementById;
    window.playSound = _origPlaySound;
    window.playRealSound = _origPlayRealSound;
    window.showMessage = _origShowMessage;
    window.createTackleParticles = _origCreateTackleParticles;
    window.setTimeout = _origSetTimeout;
    document.body.appendChild = _origAppendChild;
    console.log = _origConsoleLog;
    
    window.isHeadless = false;
    window.simHomeDiff = null; window.simAwayDiff = null;
    
    console.log("--- MONTE CARLO RESULTS ---");
    console.table(results);
    return results;
};

// Hook into existing game functions to track Telemetry without modifying massive original blocks
window._origStartPassSim = window.startPass;
window.startPass = function() {
   if (window.ballOwner) {
       window.logHeatmapEvent(window.ball.position.x, window.ball.position.z);
   }
   if (window._origStartPassSim) window._origStartPassSim();
};

window._origStartShootSim = window.startShoot;
window.startShoot = function() {
   if (window.ballOwner) {
       const teamStr = window.ballOwner.isUserTeam ? 'user' : 'ai';
       window.simTelemetry.shots[teamStr]++;
       window.logHeatmapEvent(window.ball.position.x, window.ball.position.z);
       
       const distToGoal = Math.hypot(window.ball.position.x, window.ball.position.z - (window.ballOwner.isUserTeam ? -35 : 35));
       let xG = Math.max(0.01, 1.0 - (distToGoal / 35));
       window.simTelemetry.xG[teamStr] += xG;
   }
   if (window._origStartShootSim) window._origStartShootSim();
};
