/* =====================================================================
   AUTOMATA VISUALIZER
   Works with: DFA, NFA, epsilon-NFA, Mealy machine, Moore machine.

   The machine logic (reading the text, epsilon closure, stepping,
   NFA -> DFA, Mealy <-> Moore, quiz checking) now lives in the Python
   backend (automata.py, served by app.py). This file asks the server
   for those results and does the drawing.

   How the file is organised:
     1. Settings and example machines
     2. Global variables
     3. Reading the machine definition (asks the Python server)
     4. Running the machine (step, reset)
     5. Drawing the diagram (SVG)
     6. Showing the tape, verdict and explanation
     7. The transition table editor
     8. Dragging states and adding arrows
     9. Conversions (NFA -> DFA, Mealy <-> Moore)
    10. Practice quiz
    11. Start-up: tabs and buttons
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. SETTINGS AND EXAMPLE MACHINES
   --------------------------------------------------------------------- */

const EPSILON = "e"; // we type "e" for an empty move (it is shown as ε)
const NODE_RADIUS = 24; // size of a state circle
const CENTER_X = 280; // middle of the diagram (the SVG is 560 x 380)
const CENTER_Y = 190;

/*
  Machine text format (one item per line):
    start q0        -> the start state
    accept q2 q3    -> accepting states (DFA / NFA / e-NFA)
    state q4        -> a state with no arrows yet
    out q1 1        -> output of a state (Moore only)
    q0 1 q1         -> arrow from q0 to q1 on symbol 1
    q0 1/0 q1       -> Mealy arrow: on input 1, output 0
    q0 e q1         -> empty move (e-NFA)
*/
const examples = {
  dfa: {
    label: "DFA",
    input: "1101",
    text: [
      "start q0",
      "accept q2",
      "q0 0 q1",
      "q0 1 q0",
      "q1 0 q1",
      "q1 1 q2",
      "q2 0 q1",
      "q2 1 q0",
    ].join("\n"),
  },
  nfa: {
    label: "NFA",
    input: "1101",
    text: ["start q0", "accept q2", "q0 0 q0", "q0 1 q0", "q0 0 q1", "q1 1 q2"].join(
      "\n",
    ),
  },
  enfa: {
    label: "ε-NFA",
    input: "0110",
    text: [
      "start q0",
      "accept q2",
      "q0 0 q0",
      "q0 e q1",
      "q1 1 q1",
      "q1 e q2",
      "q2 0 q2",
    ].join("\n"),
  },
  mealy: {
    label: "Mealy",
    input: "0110111",
    text: ["start q0", "q0 0/0 q0", "q0 1/0 q1", "q1 0/0 q0", "q1 1/1 q1"].join("\n"),
  },
  moore: {
    label: "Moore",
    input: "0110111",
    text: [
      "start q0",
      "out q0 0",
      "out q1 0",
      "out q2 1",
      "q0 0 q0",
      "q0 1 q1",
      "q1 0 q0",
      "q1 1 q2",
      "q2 0 q0",
      "q2 1 q2",
    ].join("\n"),
  },
};

/* ---------------------------------------------------------------------
   2. GLOBAL VARIABLES (the "memory" of the app)
   --------------------------------------------------------------------- */

let mode = "dfa"; // which tab is open: dfa, nfa, enfa, mealy, moore
let machine; // the machine read from the text box
let run; // progress of the current simulation
let autoRunTimer = null; // timer used by the Run button
let conversionTimer = null; // timer used by the conversion table animation
let manualPositions = {}; // where the user dragged each state
let selectedState = null; // first state tapped when adding an arrow
let extraSymbols = []; // columns added with "+ Column"
let loadCounter = 0; // numbers each "read the machine" request, so only the newest one counts
let stepping = false; // true while the Run button is waiting for the server

/* ---------------------------------------------------------------------
   Small helper functions
   --------------------------------------------------------------------- */

// Shortcut for document.getElementById
function $(id) {
  return document.getElementById(id);
}

// Makes text safe to put inside HTML
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Shows ε instead of "e"
function showSymbol(symbol) {
  return symbol === EPSILON ? "ε" : symbol;
}

function isTransducer() {
  return mode === "mealy" || mode === "moore"; // machines that print output
}

// Talks to the Python server. With a body it sends a POST, without one a GET.
// Always returns the decoded JSON, or throws if the server cannot be reached.
async function api(path, body) {
  const options =
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        };
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Server error");
  return data;
}

function showServerError() {
  $("error").textContent = "Cannot reach the Python server. Start it with: python app.py";
}

/* ---------------------------------------------------------------------
   3. READING THE MACHINE DEFINITION
   The Python server turns the text into an object like:
   { start, accept (Set), transitions [], outputs {}, states [] }
   --------------------------------------------------------------------- */

// (Re)reads the text box, redraws the table and restarts the simulation.
// keepTable = true means "do not rebuild the table" (used while the user types in it).
async function loadMachine(keepTable) {
  const thisCall = ++loadCounter;
  let data;

  try {
    data = await api("/api/parse", { text: $("definitionText").value, mode: mode });
  } catch (problem) {
    showServerError();
    return;
  }
  if (thisCall !== loadCounter) return; // a newer request was sent meanwhile, ignore this one

  const oldStateCount = machine ? machine.states.length : -1;

  machine = data.machine;
  machine.accept = new Set(machine.accept); // the server sends a list, the page uses a Set
  machine.initial = data.initial; // where the machine is before reading anything

  if (!keepTable || machine.states.length !== oldStateCount) {
    drawTable();
  }
  $("error").textContent = machine.start ? "" : "Add a line like: start q0";
  resetRun();
}

/* ---------------------------------------------------------------------
   4. RUNNING THE MACHINE
   --------------------------------------------------------------------- */

// Go back to the beginning of the input string
function resetRun() {
  stopAutoRun();
  if (!machine) return; // the first answer from the server has not arrived yet

  run = {
    position: 0, // how many symbols have been read
    current: new Set(machine.initial.current),
    previous: new Set(), // states before the last step
    output: machine.initial.output, // output text so far (Mealy / Moore prints before reading)
  };
  redrawEverything();
}

// Read one symbol (the server works out the move). Returns true if there is more to do afterwards.
async function stepOnce() {
  if (!machine) return false;
  const input = $("inputString").value;

  const finished = run.position >= input.length;
  const stuck = run.current.size === 0;
  if (finished || stuck) return false;

  const thisRun = run;
  let data;
  try {
    data = await api("/api/step", {
      text: $("definitionText").value,
      mode: mode,
      input: input,
      position: run.position,
      current: Array.from(run.current),
      output: run.output,
    });
  } catch (problem) {
    showServerError();
    return false;
  }
  if (run !== thisRun) return false; // the user reset or edited things while we waited

  run.previous = new Set(data.previous);
  run.current = new Set(data.current);
  run.output = data.output;
  run.position = data.position;

  redrawEverything();
  return data.hasMore;
}

// The Run button: step automatically every 0.7 seconds
function toggleAutoRun() {
  if (autoRunTimer) {
    stopAutoRun();
    return;
  }
  if (!machine) return;
  if (run.position >= $("inputString").value.length) {
    resetRun(); // start again if it already finished
  }
  $("runButton").textContent = "Pause";
  const timer = setInterval(async function () {
    if (stepping) return; // still waiting for the previous step
    stepping = true;
    const hasMore = await stepOnce();
    stepping = false;
    if (!hasMore && autoRunTimer === timer) stopAutoRun();
  }, 700);
  autoRunTimer = timer;
}

function stopAutoRun() {
  if (autoRunTimer) {
    clearInterval(autoRunTimer);
    autoRunTimer = null;
  }
  $("runButton").textContent = "Run";
}

/* ---------------------------------------------------------------------
   5. DRAWING THE DIAGRAM
   --------------------------------------------------------------------- */

// Works out an (x, y) position for every state.
// States are placed on a circle, unless the user dragged them somewhere.
function getStatePositions() {
  const positions = {};
  const count = machine.states.length;

  for (let i = 0; i < count; i++) {
    const name = machine.states[i];

    if (count === 1) {
      positions[name] = { x: CENTER_X, y: CENTER_Y };
    } else {
      const angle = Math.PI + (2 * Math.PI * i) / count; // first state on the left
      const radius = count <= 2 ? 110 : 135;
      positions[name] = {
        x: CENTER_X + radius * 1.45 * Math.cos(angle),
        y: CENTER_Y + radius * Math.sin(angle),
      };
    }
    if (manualPositions[name]) {
      positions[name] = manualPositions[name];
    }
  }
  return positions;
}

// Combines arrows with the same start and end into one arrow with a joined label.
// Example: q0 --0--> q1 and q0 --1--> q1 become one arrow labelled "0, 1".
function groupArrows() {
  const groups = {};

  for (const t of machine.transitions) {
    const key = t.from + "->" + t.to;
    if (!groups[key]) {
      groups[key] = { from: t.from, to: t.to, labels: [] };
    }

    let label = showSymbol(t.symbol);
    if (mode === "mealy") label = t.symbol + "/" + t.output;

    if (!groups[key].labels.includes(label)) {
      groups[key].labels.push(label);
    }
  }
  return groups;
}

// A point that is `distance` away from `from`, in the direction of `towards`
function pointTowards(from, towards, distance) {
  const dx = towards.x - from.x;
  const dy = towards.y - from.y;
  const length = Math.hypot(dx, dy);
  return { x: from.x + (dx / length) * distance, y: from.y + (dy / length) * distance };
}

function drawDiagram() {
  const positions = getStatePositions();
  const groups = groupArrows();
  const R = NODE_RADIUS;

  // Arrow head shape
  let svg =
    '<defs><marker id="arrowHead" viewBox="0 0 10 10" refX="9" refY="5" ' +
    'markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    '<path d="M0 0L10 5L0 10z" fill="var(--ink)"/></marker></defs>';

  // ----- arrows -----
  for (const key in groups) {
    const group = groups[key];
    const a = positions[group.from];
    const b = positions[group.to];
    const labelText = escapeHtml(group.labels.join(", "));

    if (group.from === group.to) {
      // Self-loop: a little loop that sticks out away from the center
      let dx = a.x - CENTER_X;
      let dy = a.y - CENTER_Y;
      let dist = Math.hypot(dx, dy);
      if (dist < 1) {
        dx = 0;
        dy = -1;
        dist = 1;
      } // state exactly in the center: loop goes up
      dx = dx / dist;
      dy = dy / dist;
      const px = -dy; // sideways direction
      const py = dx;

      const loopStart = {
        x: a.x + dx * R * 0.9 + px * R * 0.5,
        y: a.y + dy * R * 0.9 + py * R * 0.5,
      };
      const loopEnd = {
        x: a.x + dx * R * 0.9 - px * R * 0.5,
        y: a.y + dy * R * 0.9 - py * R * 0.5,
      };
      const control1 = {
        x: a.x + dx * (R + 55) + px * 34,
        y: a.y + dy * (R + 55) + py * 34,
      };
      const control2 = {
        x: a.x + dx * (R + 55) - px * 34,
        y: a.y + dy * (R + 55) - py * 34,
      };

      svg +=
        '<path d="M' +
        loopStart.x +
        " " +
        loopStart.y +
        " C" +
        control1.x +
        " " +
        control1.y +
        " " +
        control2.x +
        " " +
        control2.y +
        " " +
        loopEnd.x +
        " " +
        loopEnd.y +
        '" fill="none" stroke="var(--ink)" stroke-width="1.5" marker-end="url(#arrowHead)"/>';
      svg +=
        '<text x="' +
        (a.x + dx * (R + 44)) +
        '" y="' +
        (a.y + dy * (R + 44) + 4) +
        '" text-anchor="middle" font-size="13" fill="var(--accent)">' +
        labelText +
        "</text>";
    } else {
      // Normal arrow. If there is also an arrow back, bend both so they do not overlap.
      const hasReverse = groups[group.to + "->" + group.from] !== undefined;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      dx = dx / length;
      dy = dy / length;

      const bend = hasReverse ? 30 : 0;
      const control = { x: midX - dy * bend, y: midY + dx * bend };

      const start = pointTowards(a, control, R); // leave the edge of circle a
      const end = pointTowards(b, control, R + 3); // stop just before circle b

      svg +=
        '<path d="M' +
        start.x +
        " " +
        start.y +
        " Q" +
        control.x +
        " " +
        control.y +
        " " +
        end.x +
        " " +
        end.y +
        '" fill="none" stroke="var(--ink)" stroke-width="1.5" marker-end="url(#arrowHead)"/>';

      const shift = hasReverse ? 4 : -12; // keep the label off the line
      const labelX = 0.25 * start.x + 0.5 * control.x + 0.25 * end.x - dy * shift;
      const labelY = 0.25 * start.y + 0.5 * control.y + 0.25 * end.y + dx * shift;
      svg +=
        '<text x="' +
        labelX +
        '" y="' +
        (labelY + 4) +
        '" text-anchor="middle" font-size="13" fill="var(--accent)">' +
        labelText +
        "</text>";
    }
  }

  // ----- arrow pointing at the start state -----
  if (machine.start && positions[machine.start]) {
    const p = positions[machine.start];
    svg +=
      '<path d="M' +
      (p.x - R - 34) +
      " " +
      p.y +
      "L" +
      (p.x - R - 2) +
      " " +
      p.y +
      '" stroke="var(--ink)" stroke-width="1.5" marker-end="url(#arrowHead)"/>';
  }

  // ----- state circles -----
  for (const name of machine.states) {
    const p = positions[name];
    const isCurrent = run && run.current.has(name);
    const isSelected = selectedState === name;
    const textColor = isCurrent ? "#12303b" : "var(--ink)";

    svg += '<g data-state="' + escapeHtml(name) + '" style="cursor:grab">';
    svg +=
      '<circle cx="' +
      p.x +
      '" cy="' +
      p.y +
      '" r="' +
      R +
      '" ' +
      'fill="' +
      (isCurrent ? "var(--live)" : "var(--panel)") +
      '" ' +
      'stroke="var(--ink)" stroke-width="' +
      (isSelected ? 5 : 2) +
      '"/>';

    // Accepting states get a second, inner circle
    if (machine.accept.has(name)) {
      svg +=
        '<circle cx="' +
        p.x +
        '" cy="' +
        p.y +
        '" r="' +
        (R - 5) +
        '" ' +
        'fill="none" stroke="var(--ink)" stroke-width="1.5"/>';
    }

    // State name (in a Moore machine it sits a little higher to make room for the output)
    const nameY = mode === "moore" ? p.y - 1 : p.y + 5;
    svg +=
      '<text x="' +
      p.x +
      '" y="' +
      nameY +
      '" text-anchor="middle" ' +
      'font-size="15" font-weight="600" fill="' +
      textColor +
      '">' +
      escapeHtml(name) +
      "</text>";

    if (mode === "moore") {
      const outputText = machine.outputs[name] || "-";
      svg +=
        '<text x="' +
        p.x +
        '" y="' +
        (p.y + 13) +
        '" text-anchor="middle" ' +
        'font-size="12" fill="' +
        (isCurrent ? "#12303b" : "var(--muted)") +
        '">out ' +
        escapeHtml(outputText) +
        "</text>";
    }
    svg += "</g>";
  }

  $("diagram").innerHTML = svg;
}

/* ---------------------------------------------------------------------
   6. TAPE, VERDICT AND EXPLANATION
   --------------------------------------------------------------------- */

function redrawEverything() {
  drawDiagram();

  const input = $("inputString").value;

  // ----- the tape: one box per input symbol -----
  let tapeHtml = "";
  for (let i = 0; i < input.length; i++) {
    let cssClass = "";
    if (i < run.position)
      cssClass = "done"; // already read
    else if (i === run.position) cssClass = "now"; // read next
    tapeHtml += '<span class="' + cssClass + '">' + escapeHtml(input[i]) + "</span>";
  }
  $("tape").innerHTML = tapeHtml;

  // ----- output line (Mealy / Moore only) -----
  $("outputLine").textContent = isTransducer() ? "Output: " + run.output : "";

  // ----- verdict -----
  const finished = run.position >= input.length;
  const stuck = run.current.size === 0;
  const inAcceptState = Array.from(run.current).some(function (s) {
    return machine.accept.has(s);
  });

  const verdict = $("verdict");
  verdict.className = "verdict";
  verdict.textContent = "";

  if (stuck) {
    verdict.textContent = "Stuck: no move for the next symbol.";
    verdict.classList.add("bad");
  } else if (finished && !isTransducer()) {
    verdict.textContent = inAcceptState ? "Accepted" : "Rejected";
    verdict.classList.add(inAcceptState ? "ok" : "bad");
  } else if (finished && isTransducer()) {
    verdict.textContent = "Done";
  }

  // ----- plain-English explanation of the last step -----
  const explanation = $("explanation");
  const currentNames = Array.from(run.current).join(", ");

  if (run.position === 0) {
    if (mode === "enfa") {
      explanation.textContent =
        "Free ε-moves from the start put you in: " + currentNames + ".";
    } else {
      explanation.textContent = "Start in: " + currentNames + ".";
    }
  } else {
    const symbolRead = input[run.position - 1];
    const previousNames = Array.from(run.previous).join(", ");

    if (stuck) {
      explanation.textContent =
        'Read "' +
        symbolRead +
        '" in ' +
        previousNames +
        ": no arrow for it, so the machine is stuck and the string is rejected.";
    } else {
      let text =
        'Read "' + symbolRead + '": ' + previousNames + " → " + currentNames + ".";

      if (finished && !isTransducer()) {
        if (inAcceptState) {
          text += " That is an accepting state.";
        } else {
          const acceptList = Array.from(machine.accept).join(", ") || "none set";
          text +=
            " That is not an accepting state (accepting: " +
            acceptList +
            "), so the string is rejected.";
        }
      }
      explanation.textContent = text;
    }
  }
}

/* ---------------------------------------------------------------------
   7. THE TRANSITION TABLE EDITOR
   Rows = states, columns = symbols, each cell = the next state(s).
   --------------------------------------------------------------------- */

// Which symbol columns to show: every symbol used in an arrow,
// plus columns the user added, plus "e" for an e-NFA.
function getSymbolColumns() {
  const symbols = [];

  for (const t of machine.transitions) {
    if (t.symbol !== EPSILON && !symbols.includes(t.symbol)) symbols.push(t.symbol);
  }
  for (const s of extraSymbols) {
    if (!symbols.includes(s)) symbols.push(s);
  }
  if (symbols.length === 0) {
    symbols.push("0", "1"); // default columns for an empty machine
  }
  symbols.sort();

  const usesEpsilon = machine.transitions.some(function (t) {
    return t.symbol === EPSILON;
  });
  if (mode === "enfa" || usesEpsilon) symbols.push(EPSILON);

  return symbols;
}

// Text for one table cell, e.g. "q1" or "q1,q2" (Mealy: "q1/0")
function getCellText(state, symbol) {
  const parts = [];
  for (const t of machine.transitions) {
    if (t.from === state && t.symbol === symbol) {
      parts.push(mode === "mealy" ? t.to + "/" + t.output : t.to);
    }
  }
  return parts.join(",");
}

function drawTable() {
  const symbols = getSymbolColumns();
  const showOutputColumn = mode === "moore";
  const showAcceptColumn = mode === "dfa" || mode === "nfa" || mode === "enfa";

  // header row
  let html = '<table class="transition-table"><tr><th>Start</th>';
  if (showAcceptColumn) html += "<th>Accept</th>";
  html += "<th>State</th>";
  for (const symbol of symbols) {
    html += "<th>" + escapeHtml(showSymbol(symbol)) + "</th>";
  }
  if (showOutputColumn) html += "<th>Output</th>";
  html += "</tr>";

  // one row per state
  for (const state of machine.states) {
    const name = escapeHtml(state);
    const isStart = machine.start === state;
    const isAccepting = machine.accept.has(state);

    html += '<tr data-state="' + name + '">';
    html +=
      '<td><input type="radio" name="startState" aria-label="Start state ' +
      name +
      '"' +
      (isStart ? " checked" : "") +
      "></td>";

    if (showAcceptColumn) {
      html +=
        '<td><input type="checkbox" class="accept-box" aria-label="' +
        name +
        ' accepting"' +
        (isAccepting ? " checked" : "") +
        "></td>";
    }

    html += "<th>" + name + "</th>";

    for (const symbol of symbols) {
      html +=
        '<td><input type="text" data-symbol="' +
        escapeHtml(symbol) +
        '" ' +
        'value="' +
        escapeHtml(getCellText(state, symbol)) +
        '" ' +
        'aria-label="' +
        name +
        " on " +
        escapeHtml(symbol) +
        '"></td>';
    }

    if (showOutputColumn) {
      html +=
        '<td><input type="text" class="output-box" value="' +
        escapeHtml(machine.outputs[state] || "") +
        '" aria-label="' +
        name +
        ' output"></td>';
    }
    html += "</tr>";
  }
  html += "</table>";

  // "add a column" controls
  html +=
    '<div class="button-row">' +
    '<input type="text" id="newSymbol" placeholder="new symbol" aria-label="New symbol" style="width:110px">' +
    '<button id="addColumnButton" class="outline">+ Column</button></div>';

  $("tableArea").innerHTML = html;
}

// Called when the user changes something in the table.
// It rebuilds the machine text from the table, then reloads the machine.
function onTableChange(event) {
  if (event.target.id === "newSymbol") return;

  const rows = document.querySelectorAll("#tableArea tr[data-state]");
  const lines = [];
  const acceptStates = [];

  for (const row of rows) {
    const state = row.dataset.state;

    // start state (the radio button that is selected)
    if (row.querySelector('input[type="radio"]').checked) {
      lines.push("start " + state);
    }
    // accepting states (ticked boxes)
    const box = row.querySelector(".accept-box");
    if (box && box.checked) acceptStates.push(state);

    lines.push("state " + state);

    // Moore output
    const outputBox = row.querySelector(".output-box");
    if (outputBox) lines.push("out " + state + " " + outputBox.value.trim());

    // the arrows from this state
    const cells = row.querySelectorAll("input[data-symbol]");
    for (const cell of cells) {
      const symbol = cell.dataset.symbol;
      const targets = cell.value.split(",");

      for (let target of targets) {
        target = target.trim();
        if (target === "") continue;

        if (mode === "mealy") {
          const parts = target.split("/"); // "q1/0" -> next state q1, output 0
          const nextState = parts[0].trim();
          const output = (parts[1] || "").trim();
          lines.push(state + " " + symbol + "/" + output + " " + nextState);
        } else {
          lines.push(state + " " + symbol + " " + target);
        }
      }
    }
  }
  if (acceptStates.length > 0) lines.push("accept " + acceptStates.join(" "));

  $("definitionText").value = lines.join("\n");
  loadMachine(true); // true = keep the table as it is (so the cursor does not jump)
}

function onTableClick(event) {
  if (event.target.id === "addColumnButton") {
    const symbol = $("newSymbol").value.trim();
    if (symbol !== "" && symbol !== EPSILON && !extraSymbols.includes(symbol)) {
      extraSymbols.push(symbol);
      drawTable();
    }
  }
}

// Adds one line to the machine text and reloads
function addLineToText(line) {
  const box = $("definitionText");
  box.value = box.value.replace(/\s*$/, "\n") + line;
  loadMachine();
}

/* ---------------------------------------------------------------------
   8. DRAGGING STATES AND ADDING ARROWS
   - drag a state to move it
   - tap one state, then another, to add an arrow
   - double-tap a state to make it accepting / not accepting
   --------------------------------------------------------------------- */

let draggedState = null; // name of the state being dragged
let hasMoved = false; // did the pointer really move (or was it just a tap)?
let pressX = 0;
let pressY = 0;
let lastTap = { state: null, time: 0 };

function onDiagramPointerDown(event) {
  const node = event.target.closest("[data-state]");
  if (!node) return;
  draggedState = node.dataset.state;
  hasMoved = false;
  pressX = event.clientX;
  pressY = event.clientY;
}

function onPointerMove(event) {
  if (!draggedState) return;

  // ignore tiny movements so a tap is not mistaken for a drag
  const distance = Math.hypot(event.clientX - pressX, event.clientY - pressY);
  if (!hasMoved && distance < 6) return;
  hasMoved = true;

  // convert screen position -> position inside the SVG
  const svg = $("diagram");
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
    svg.getScreenCTM().inverse(),
  );

  // keep the state inside the picture
  manualPositions[draggedState] = {
    x: Math.max(26, Math.min(534, point.x)),
    y: Math.max(26, Math.min(354, point.y)),
  };
  drawDiagram();
}

function onPointerUp() {
  if (!draggedState) return;

  const state = draggedState;
  draggedState = null;
  if (hasMoved) return; // it was a drag, nothing else to do

  // It was a tap. Two quick taps on the same state = double-tap.
  const now = Date.now();
  if (lastTap.state === state && now - lastTap.time < 350) {
    lastTap = { state: null, time: 0 };
    toggleAccepting(state);
  } else {
    lastTap = { state: state, time: now };
    handleStateTap(state);
  }
}

// First tap selects a state, second tap on another state adds an arrow
function handleStateTap(state) {
  if (selectedState === null) {
    selectedState = state;
  } else if (selectedState === state) {
    selectedState = null; // tapped the same one again: unselect
  } else {
    let symbol = $("arrowSymbol").value.trim();
    if (symbol === "") symbol = mode === "mealy" ? "0/0" : "0";
    const from = selectedState;
    selectedState = null;
    addLineToText(from + " " + symbol + " " + state);
    return;
  }
  drawDiagram();
}

function toggleAccepting(state) {
  selectedState = null;

  const acceptList = new Set(machine.accept);
  if (acceptList.has(state)) acceptList.delete(state);
  else acceptList.add(state);

  // remove the old "accept" line(s) and write a new one
  const keptLines = $("definitionText")
    .value.split("\n")
    .filter(function (line) {
      return !/^\s*accept\b/.test(line);
    });
  keptLines.push("accept " + Array.from(acceptList).join(" "));
  $("definitionText").value = keptLines.join("\n");
  loadMachine();
}

function addNewState() {
  if (!machine) return; // the first answer from the server has not arrived yet
  let number = machine.states.length;
  while (machine.states.includes("q" + number)) number++;
  const name = "q" + number;

  // put it somewhere random so it does not hide behind another state
  manualPositions[name] = { x: 90 + Math.random() * 380, y: 50 + Math.random() * 280 };
  addLineToText("state " + name);
}

function makeBlankMachine() {
  manualPositions = {};
  $("definitionText").value = "start q0";
  $("inputString").value = "";
  loadMachine();
}

/* ---------------------------------------------------------------------
   9. CONVERSIONS
   Both conversions show an animated table, then a button loads the result.
   --------------------------------------------------------------------- */

// Shows a table that fills one row at a time.
//   note    = explanation sentence above the table
//   headers = column titles
//   rows    = array of rows, each row is an array of cell texts
//   loadLabel / onLoad = the button shown at the end
function showAnimatedTable(note, headers, rows, loadLabel, onLoad) {
  clearInterval(conversionTimer);
  const box = $("conversionBox");
  box.hidden = false;

  let rowsShown = 0;

  function paint() {
    let html = "<b>" + escapeHtml(note) + "</b><table><tr>";
    for (const h of headers) html += "<th>" + escapeHtml(h) + "</th>";
    html += "</tr>";

    for (let i = 0; i < rowsShown; i++) {
      html += "<tr>";
      for (const cell of rows[i]) html += "<td>" + escapeHtml(cell) + "</td>";
      html += "</tr>";
    }
    html += "</table>";

    const allShown = rowsShown >= rows.length;
    if (allShown) {
      html +=
        '<button id="loadButton" class="load-button">' +
        escapeHtml(loadLabel) +
        "</button>";
    }
    box.innerHTML = html;

    if (allShown) {
      clearInterval(conversionTimer);
      $("loadButton").onclick = onLoad;
    }
  }

  paint();
  if (rowsShown < rows.length) {
    conversionTimer = setInterval(function () {
      rowsShown++;
      paint();
    }, 700);
  }
}

// The Convert button. The Python server builds the table and the new machine:
//   NFA / e-NFA -> DFA (subset construction), Mealy -> Moore, Moore -> Mealy.
async function onConvertClick() {
  if (!machine) return;
  const modeWhenClicked = mode;
  let data;

  try {
    data = await api("/api/convert", { text: $("definitionText").value, mode: mode });
  } catch (problem) {
    showServerError();
    return;
  }
  if (mode !== modeWhenClicked) return; // the user switched tabs while we waited

  if (data.error) {
    $("error").textContent = data.error;
    return;
  }

  showAnimatedTable(data.note, data.headers, data.rows, data.loadLabel, function () {
    switchMode(data.targetMode);
    $("definitionText").value = data.text;
    loadMachine();
  });
}

/* ---------------------------------------------------------------------
   10. PRACTICE QUIZ
   The Python server tests the machine on every binary string up to
   length 8 (511 strings).
   --------------------------------------------------------------------- */

async function checkQuiz() {
  const result = $("quizResult");
  result.className = "verdict";

  if (isTransducer()) {
    result.textContent = "Switch to a DFA, NFA or ε-NFA tab first.";
    result.classList.add("bad");
    return;
  }

  let data;
  try {
    data = await api("/api/quiz", {
      text: $("definitionText").value,
      mode: mode,
      language: Number($("quizSelect").value),
    });
  } catch (problem) {
    showServerError();
    return;
  }

  result.className = "verdict";
  result.textContent = data.message;
  result.classList.add(data.ok ? "ok" : "bad");

  if (data.failing !== null) {
    $("inputString").value = data.failing; // load the failing string so the user can watch it
    resetRun();
  }
}

/* ---------------------------------------------------------------------
   11. START-UP: TABS AND BUTTONS
   --------------------------------------------------------------------- */

// Text under the table, depends on the tab
function makeHint(tab) {
  let text = "Type the next state in each cell";

  if (tab === "nfa") text += " (several states separated by commas)";
  if (tab === "enfa") text += " (several separated by commas, ε column = free moves)";
  if (tab === "mealy") text += ", as next/output, like q1/0";
  if (tab === "moore") text += " and give each state an output";

  text += ". Pick the start state with the round button";
  if (tab === "mealy" || tab === "moore") text += ".";
  else text += " and tick the box on accepting states.";
  return text;
}

// Switch to another tab and load its example
function switchMode(newMode) {
  mode = newMode;
  manualPositions = {};
  selectedState = null;
  extraSymbols = [];
  clearInterval(conversionTimer);
  $("conversionBox").hidden = true;

  // The convert button is not needed on the DFA tab
  const convertButton = $("convertButton");
  convertButton.hidden = newMode === "dfa";
  if (newMode === "mealy") convertButton.textContent = "Convert to Moore";
  else if (newMode === "moore") convertButton.textContent = "Convert to Mealy";
  else convertButton.textContent = "Convert to DFA";

  // highlight the open tab
  const tabButtons = document.querySelectorAll("#tabs button");
  for (const button of tabButtons) {
    button.setAttribute(
      "aria-selected",
      button.dataset.mode === newMode ? "true" : "false",
    );
  }

  $("definitionText").value = examples[newMode].text;
  $("inputString").value = examples[newMode].input;
  $("hint").textContent = makeHint(newMode);
  loadMachine();
}

// Create one button per tab
for (const key in examples) {
  const button = document.createElement("button");
  button.textContent = examples[key].label;
  button.dataset.mode = key;
  button.setAttribute("role", "tab");
  button.onclick = function () {
    switchMode(key);
  };
  $("tabs").appendChild(button);
}

// Fill the quiz drop-down (the language names come from the Python server)
async function fillQuizList() {
  try {
    const data = await api("/api/quiz-languages");
    data.languages.forEach(function (name, index) {
      const option = document.createElement("option");
      option.value = index;
      option.textContent = name;
      $("quizSelect").appendChild(option);
    });
  } catch (problem) {
    showServerError();
  }
}
fillQuizList();

// Connect buttons and events
$("definitionText").oninput = function () {
  loadMachine();
};
$("inputString").oninput = resetRun;
$("stepButton").onclick = function () {
  stopAutoRun();
  stepOnce();
};
$("runButton").onclick = toggleAutoRun;
$("resetButton").onclick = resetRun;
$("addStateButton").onclick = addNewState;
$("blankButton").onclick = makeBlankMachine;
$("convertButton").onclick = onConvertClick;
$("checkButton").onclick = checkQuiz;

$("tableArea").addEventListener("change", onTableChange);
$("tableArea").addEventListener("click", onTableClick);

$("diagram").addEventListener("pointerdown", onDiagramPointerDown);
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);

// Start with the DFA tab open
switchMode("dfa");
