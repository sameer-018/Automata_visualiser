"""
Flask server for the Automata Visualizer.

  python app.py   ->   open http://127.0.0.1:5000

It does two things:
  1. Serves the page (index.html, style.css, app.js).
  2. Provides a small JSON API; the machine logic lives in automata.py.

API (all JSON):
  GET  /api/quiz-languages   -> {"languages": [names]}
  POST /api/parse            {text, mode}                              -> {machine, initial}
  POST /api/step             {text, mode, input, position, current, output} -> new run state
  POST /api/convert          {text, mode}                              -> conversion table
  POST /api/quiz             {text, mode, language}                    -> {ok, message, failing}
"""

from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

import automata

BASE_DIR = Path(__file__).resolve().parent
VALID_MODES = {"dfa", "nfa", "enfa", "mealy", "moore"}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024  # a machine definition is tiny


# ---------------------------------------------------------------------
# The page itself (only these three files are served)
# ---------------------------------------------------------------------


@app.get("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/style.css")
def stylesheet():
    return send_from_directory(BASE_DIR, "style.css")


@app.get("/app.js")
def script():
    return send_from_directory(BASE_DIR, "app.js")


# ---------------------------------------------------------------------
# Helpers for reading the request
# ---------------------------------------------------------------------


@app.errorhandler(400)
@app.errorhandler(413)
def bad_request(error):
    return jsonify({"error": getattr(error, "description", "Bad request")}), error.code


def read_json():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400, "Send a JSON object.")
    return data


def read_mode(data):
    mode = data.get("mode", "dfa")
    if mode not in VALID_MODES:
        abort(400, "Unknown mode.")
    return mode


def read_string(data, key):
    value = data.get(key, "")
    if not isinstance(value, str):
        abort(400, "'" + key + "' must be text.")
    return value


def read_machine(data):
    mode = read_mode(data)
    return mode, automata.parse_machine(read_string(data, "text"), mode)


# ---------------------------------------------------------------------
# API
# ---------------------------------------------------------------------


@app.get("/api/quiz-languages")
def quiz_languages():
    return jsonify({"languages": automata.quiz_language_names()})


@app.post("/api/parse")
def parse():
    mode, machine = read_machine(read_json())
    return jsonify({"machine": machine, "initial": automata.initial_run(machine, mode)})


@app.post("/api/step")
def step():
    data = read_json()
    mode, machine = read_machine(data)

    position = data.get("position", 0)
    current = data.get("current", [])
    if not isinstance(position, int) or isinstance(position, bool) or position < 0:
        abort(400, "'position' must be a whole number.")
    if not isinstance(current, list) or not all(isinstance(s, str) for s in current):
        abort(400, "'current' must be a list of state names.")

    result = automata.step_once(
        machine,
        mode,
        read_string(data, "input"),
        position,
        current,
        read_string(data, "output"),
    )
    return jsonify(result)


@app.post("/api/convert")
def convert():
    mode, machine = read_machine(read_json())
    return jsonify(automata.convert(machine, mode))


@app.post("/api/quiz")
def quiz():
    data = read_json()
    mode, machine = read_machine(data)

    language = data.get("language", 0)
    if (
        not isinstance(language, int)
        or isinstance(language, bool)
        or not 0 <= language < len(automata.QUIZ_LANGUAGES)
    ):
        abort(400, "Unknown quiz language.")

    return jsonify(automata.check_quiz(machine, language))


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
