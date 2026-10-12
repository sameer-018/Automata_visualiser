"""
Automata logic (the "brain" of the Automata Visualizer).

Works with: DFA, NFA, epsilon-NFA, Mealy machine, Moore machine.

This is a direct port of the logic that used to live in app.js:
  1. Reading the machine definition (text -> machine dict)
  2. Running the machine (epsilon closure, one step)
  3. Conversions (NFA -> DFA, Mealy <-> Moore)
  4. Practice quiz

A "machine" is a plain dict (so it can be sent as JSON):
  {
    "start": "q0" or None,
    "accept": ["q2", ...],
    "transitions": [{"from": "q0", "symbol": "1", "to": "q1", "output": ""}, ...],
    "outputs": {"q0": "1", ...},      # Moore outputs
    "states": ["q0", "q1", ...],      # all state names, in order
  }

Sets of states are kept as ordered lists, so the order shown on screen
matches what the JavaScript version showed.
"""

EPSILON = "e"  # we type "e" for an empty move (it is shown as ε)


# ---------------------------------------------------------------------
# 1. READING THE MACHINE DEFINITION
#
# Machine text format (one item per line):
#   start q0        -> the start state
#   accept q2 q3    -> accepting states (DFA / NFA / e-NFA)
#   state q4        -> a state with no arrows yet
#   out q1 1        -> output of a state (Moore only)
#   q0 1 q1         -> arrow from q0 to q1 on symbol 1
#   q0 1/0 q1       -> Mealy arrow: on input 1, output 0
#   q0 e q1         -> empty move (e-NFA)
# ---------------------------------------------------------------------


def parse_machine(text, mode):
    machine = {
        "start": None,
        "accept": [],
        "transitions": [],  # each one: from, symbol, to, output
        "outputs": {},  # Moore outputs, e.g. {"q0": "1"}
        "states": [],  # all state names, in order
    }

    def add_state(name):
        if name not in machine["states"]:
            machine["states"].append(name)

    for line in text.split("\n"):
        words = line.split()
        if not words:  # skip empty lines
            continue
        first = words[0]

        if first == "start" and len(words) > 1:
            machine["start"] = words[1]
            add_state(words[1])
        elif first == "accept":
            for name in words[1:]:
                if name not in machine["accept"]:
                    machine["accept"].append(name)
                add_state(name)
        elif first == "state" and len(words) > 1:
            add_state(words[1])
        elif first == "out" and len(words) > 1:
            machine["outputs"][words[1]] = words[2] if len(words) > 2 else ""
            add_state(words[1])
        elif len(words) >= 3:
            # A normal arrow: from  symbol  to
            source = words[0]
            target = words[2]
            symbol = words[1]
            output = ""

            # In a Mealy machine the middle part looks like "1/0"
            if mode == "mealy":
                parts = words[1].split("/")
                symbol = parts[0]
                output = parts[1] if len(parts) > 1 else ""

            machine["transitions"].append(
                {"from": source, "symbol": symbol, "to": target, "output": output}
            )
            add_state(source)
            add_state(target)

    # If no start line was given, use the first state
    if machine["start"] is None and machine["states"]:
        machine["start"] = machine["states"][0]
    return machine


# ---------------------------------------------------------------------
# 2. RUNNING THE MACHINE
# ---------------------------------------------------------------------


def epsilon_closure(machine, start_states):
    """All states you can reach from start_states using only empty moves (e).
    For DFA / Mealy / Moore there are no empty moves, so nothing changes."""
    result = list(dict.fromkeys(start_states))  # ordered, no duplicates
    seen = set(result)
    to_visit = list(result)

    while to_visit:
        state = to_visit.pop()
        for t in machine["transitions"]:
            if t["from"] == state and t["symbol"] == EPSILON and t["to"] not in seen:
                seen.add(t["to"])
                result.append(t["to"])
                to_visit.append(t["to"])
    return result


def initial_run(machine, mode):
    """The state of a simulation before any symbol has been read."""
    start = machine["start"]
    output = ""
    if mode == "moore" and start is not None:
        output = machine["outputs"].get(start, "")  # Moore prints before reading
    current = epsilon_closure(machine, [start]) if start is not None else []
    return {"current": current, "output": output}


def step_once(machine, mode, text, position, current, output):
    """Read one symbol. Returns the new run state plus whether there is more to do."""
    finished = position >= len(text)
    stuck = len(current) == 0
    if finished or stuck:
        return {
            "current": current,
            "previous": current,
            "output": output,
            "position": position,
            "hasMore": False,
        }

    symbol = text[position]
    current_set = set(current)
    next_states = []
    new_output = ""

    # Follow every arrow that leaves a current state with this symbol
    for t in machine["transitions"]:
        if t["from"] in current_set and t["symbol"] == symbol:
            if t["to"] not in next_states:
                next_states.append(t["to"])
            if mode == "mealy":
                new_output += t["output"]  # output is on the arrow

    if mode == "moore":
        for state in next_states:
            new_output += machine["outputs"].get(state, "")  # output is in the state

    new_current = epsilon_closure(machine, next_states)
    new_position = position + 1
    return {
        "current": new_current,
        "previous": list(current),
        "output": output + new_output,
        "position": new_position,
        "hasMore": new_position < len(text) and len(new_current) > 0,
    }


def machine_accepts(machine, text):
    """Does the machine accept this string? (used by the quiz)"""
    if machine["start"] is None:
        return False
    current = epsilon_closure(machine, [machine["start"]])

    for symbol in text:
        nxt = []
        current_set = set(current)
        for t in machine["transitions"]:
            if t["from"] in current_set and t["symbol"] == symbol:
                nxt.append(t["to"])
        current = epsilon_closure(machine, nxt)
        if not current:  # no way forward
            return False

    accept = set(machine["accept"])
    return any(state in accept for state in current)


# ---------------------------------------------------------------------
# 3. CONVERSIONS
# Each one returns what the page needs to show an animated table:
#   note, headers, rows, loadLabel, targetMode, text
# ---------------------------------------------------------------------

NO_START_MESSAGE = "Add a line like: start q0"


def convert(machine, mode):
    if machine["start"] is None:
        return {"error": NO_START_MESSAGE}
    if mode == "mealy":
        return mealy_to_moore(machine)
    if mode == "moore":
        return moore_to_mealy(machine)
    return nfa_to_dfa(machine)


# ----- NFA / e-NFA  ->  DFA  (subset construction) -----
def nfa_to_dfa(machine):
    # all real symbols (not "e")
    symbols = sorted(
        {t["symbol"] for t in machine["transitions"] if t["symbol"] != EPSILON}
    )

    dfa_names = {}  # e.g. {"q0,q1": "S0"}
    waiting = []  # sets of NFA states still to be processed
    dfa_rows = []
    accept = set(machine["accept"])

    # Gives a set of NFA states a DFA name (S0, S1, ...), creating one if it is new
    def name_for(state_set):
        key = ",".join(sorted(state_set))
        if key not in dfa_names:
            dfa_names[key] = "S" + str(len(dfa_names))
            waiting.append(set(state_set))
        return dfa_names[key]

    # The start DFA state = start NFA state + everything reachable by empty moves
    name_for(epsilon_closure(machine, [machine["start"]]))

    while waiting:
        state_set = waiting.pop(0)
        key = ",".join(sorted(state_set))

        row = {
            "name": dfa_names[key],
            "nfaStates": key,
            "accepting": any(s in accept for s in state_set),
            "moves": {},
        }

        for symbol in symbols:
            # where can we get to from ANY state in the set, using this symbol?
            reached = [
                t["to"]
                for t in machine["transitions"]
                if t["from"] in state_set and t["symbol"] == symbol
            ]
            closure = epsilon_closure(machine, reached)
            row["moves"][symbol] = name_for(closure) if closure else ""
        dfa_rows.append(row)

    # build the rows shown on screen
    table_rows = []
    for row in dfa_rows:
        cells = [
            row["name"] + (" ✓" if row["accepting"] else ""),
            "{" + row["nfaStates"] + "}",
        ]
        for symbol in symbols:
            cells.append(row["moves"][symbol] or "–")
        table_rows.append(cells)
    headers = ["DFA state", "NFA states"] + ["on " + s for s in symbols]

    # the DFA as machine text (for the Load button)
    accept_names = [r["name"] for r in dfa_rows if r["accepting"]]
    lines = ["start S0", "accept " + " ".join(accept_names)]
    for row in dfa_rows:
        for symbol in symbols:
            if row["moves"][symbol]:
                lines.append(row["name"] + " " + symbol + " " + row["moves"][symbol])

    return {
        "note": "Subset construction: each DFA state is a set of NFA states you can be in at once.",
        "headers": headers,
        "rows": table_rows,
        "loadLabel": "Load as DFA",
        "targetMode": "dfa",
        "text": "\n".join(lines),
    }


# ----- Mealy -> Moore: split each state into one copy per output it receives -----
def mealy_to_moore(machine):
    # outputs_received["q1"] = ["0", "1"]  (outputs on arrows that enter q1)
    outputs_received = {state: [] for state in machine["states"]}

    for t in machine["transitions"]:
        if t["output"] not in outputs_received[t["to"]]:
            outputs_received[t["to"]].append(t["output"])
    # the start state also gets a copy with output 0 (Moore prints before reading anything)
    start = machine["start"]
    if start and "0" not in outputs_received[start]:
        outputs_received[start].insert(0, "0")

    def copy_name(state, output):
        return state + "_" + output  # q1 with output 0 -> "q1_0"

    # table rows
    table_rows = []
    for state in machine["states"]:
        outputs = outputs_received[state]
        copies = [copy_name(state, o) for o in outputs]
        table_rows.append(
            [
                state,
                ", ".join(outputs) or "none",
                ", ".join(copies) or "dropped (unreachable)",
            ]
        )

    # new Moore machine text
    lines = ["start " + copy_name(start, "0")]
    for state in machine["states"]:
        for output in outputs_received[state]:
            lines.append("out " + copy_name(state, output) + " " + output)
    for t in machine["transitions"]:
        for from_output in outputs_received[t["from"]]:
            lines.append(
                copy_name(t["from"], from_output)
                + " "
                + t["symbol"]
                + " "
                + copy_name(t["to"], t["output"])
            )

    return {
        "note": (
            "Mealy → Moore: split each state into one copy per output it receives. "
            "The start state also gets a copy with output 0, because a Moore machine "
            "prints one extra symbol at the start."
        ),
        "headers": ["Mealy state", "Outputs it receives", "Moore states"],
        "rows": table_rows,
        "loadLabel": "Load as Moore",
        "targetMode": "moore",
        "text": "\n".join(lines),
    }


# ----- Moore -> Mealy: every arrow takes the output of the state it points to -----
def moore_to_mealy(machine):
    table_rows = []
    lines = ["start " + machine["start"]]

    for t in machine["transitions"]:
        output = machine["outputs"].get(t["to"], "")
        table_rows.append(
            [
                t["from"] + " –" + t["symbol"] + "→ " + t["to"],
                t["from"] + " –" + t["symbol"] + "/" + output + "→ " + t["to"],
            ]
        )
        lines.append(t["from"] + " " + t["symbol"] + "/" + output + " " + t["to"])

    return {
        "note": (
            "Moore → Mealy: each arrow takes the output of the state it points to. "
            "The Moore start output has no arrow, so Mealy drops it."
        ),
        "headers": ["Moore arrow", "Mealy arrow"],
        "rows": table_rows,
        "loadLabel": "Load as Mealy",
        "targetMode": "mealy",
        "text": "\n".join(lines),
    }


# ---------------------------------------------------------------------
# 4. PRACTICE QUIZ
# Tests the machine on every binary string up to length 8 (511 strings).
# Each language has a name and a test function that says whether a
# string SHOULD be accepted.
# ---------------------------------------------------------------------

QUIZ_LANGUAGES = [
    ("Ends in 01", lambda s: s.endswith("01")),
    ("Even number of 0s", lambda s: s.count("0") % 2 == 0),
    ("Contains 11", lambda s: "11" in s),
    ("No two 1s in a row", lambda s: "11" not in s),
    ("Length divisible by 3", lambda s: len(s) % 3 == 0),
]


def quiz_language_names():
    return [name for name, _ in QUIZ_LANGUAGES]


def check_quiz(machine, language_index):
    """Returns {"ok", "message", "failing"}.
    "failing" is the shortest wrong string (so the page can load it), or None."""
    _, should_accept = QUIZ_LANGUAGES[language_index]

    for length in range(0, 9):
        for number in range(2**length):
            # turn the number into a binary string of the right length, e.g. 5 -> "0101"
            text = format(number, "b").zfill(length) if length > 0 else ""

            machine_says = machine_accepts(machine, text)
            expected = should_accept(text)

            if machine_says != expected:
                shown = "(empty string)" if text == "" else text
                message = (
                    'Not yet. On "'
                    + shown
                    + '" your machine '
                    + ("accepts" if machine_says else "rejects")
                    + ", but it should "
                    + ("reject" if machine_says else "accept")
                    + "."
                )
                return {"ok": False, "message": message, "failing": text}

    return {
        "ok": True,
        "message": "Correct on all 511 strings up to length 8.",
        "failing": None,
    }
