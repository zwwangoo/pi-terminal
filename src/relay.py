import os, sys, pty, select, fcntl, termios, struct, signal, pwd, json, subprocess

# argv: cwd cols rows [spec].  fd0 = keyboard bytes in, fd1 = pty bytes out, fd3 = control lines ("R cols rows").
# spec is an optional JSON object {"tmux": bin, "sock": socket, "name": session, "key": project key,
# "create": bool}. Without it the relay runs a login shell directly on the pty (the default mode).
cwd = sys.argv[1] if len(sys.argv) > 1 else ""
cols = int(sys.argv[2]) if len(sys.argv) > 2 else 80
rows = int(sys.argv[3]) if len(sys.argv) > 3 else 24
spec = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else None

# Fallback tmux "config", used only when the user has no tmux config of their own: tmux loads
# ~/.tmux.conf (or ~/.config/tmux/tmux.conf) itself when the server starts, and that must win. The block
# is fed over stdin, so the plugin never writes a file. Lines are independent: an option an older tmux
# does not know is reported and skipped, the rest still apply.
TMUX_CONF = "\n".join([
    "set -g status off",  # the panel's own tab bar already lists the sessions
    "set -g mouse on",  # wheel scrolls tmux's history; xterm.js has none for the alternate screen
    "set -g history-limit 20000",
    "set -g escape-time 10",
    "set -g focus-events on",
    "set -g set-clipboard on",
    "set -ga terminal-features ',xterm-256color:RGB'",
]) + "\n"


def has_user_tmux_conf(home):
    xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    return any(os.path.isfile(p) for p in (
        os.path.join(home, ".tmux.conf"), os.path.join(xdg, "tmux", "tmux.conf")))


def die(msg):
    sys.stderr.write(msg.rstrip() + "\n")
    sys.stderr.flush()
    sys.exit(1)


pw = pwd.getpwuid(os.getuid())
env = dict(os.environ)
env.setdefault("HOME", pw.pw_dir)
env.setdefault("USER", pw.pw_name)
env.setdefault("LOGNAME", pw.pw_name)
env["SHELL"] = env.get("SHELL") or pw.pw_shell or "/bin/zsh"
base = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
env["PATH"] = (env["PATH"] + ":" + base) if env.get("PATH") else base
env.setdefault("LANG", "en_US.UTF-8")
env["TERM"] = "xterm-256color"
env["COLORTERM"] = "truecolor"
env["TERM_PROGRAM"] = "pi-desktop-terminal"
shell = env["SHELL"]
startdir = cwd if cwd and os.path.isdir(cwd) else pw.pw_dir

argv = [shell, "-l"]
if spec:
    # -u: treat the terminal as UTF-8 whatever the locale says, or tmux swaps non-ASCII text for "_".
    base_cmd = [spec["tmux"], "-u", "-L", spec["sock"]]

    def tmux(*a, data=None):
        return subprocess.run(base_cmd + list(a), env=env, input=data, timeout=8,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    target = "=" + spec["name"]  # "=" asks for an exact name match, not a prefix
    try:
        if tmux("has-session", "-t", target).returncode != 0:
            if not spec.get("create"):
                die("tmux session %s no longer exists" % spec["name"])
            r = tmux("new-session", "-d", "-s", spec["name"], "-x", str(cols), "-y", str(rows),
                     "-c", startdir, shell, "-l")
            if r.returncode != 0:
                die("tmux new-session failed: " + r.stderr.decode("utf-8", "replace"))
        if not has_user_tmux_conf(env["HOME"]):
            tmux("source-file", "-", data=TMUX_CONF.encode())
        if spec.get("key"):
            # set-option takes a pane-style target: an exact session match needs the trailing colon
            tmux("set-option", "-t", target + ":", "@pi_key", spec["key"])
    except (OSError, subprocess.SubprocessError) as e:
        die("tmux failed: %s" % e)
    # -d detaches any other client: one pty owns the window size, and a reattach replaces the old one.
    argv = base_cmd + ["attach-session", "-d", "-t", target]

pid, master = pty.fork()
if pid == 0:
    try:
        os.chdir(startdir)
    except OSError:
        pass
    os.execvpe(argv[0], argv, env)


def resize(c, r):
    # TIOCSWINSZ also sends SIGWINCH to the pty's foreground process group; no manual kill needed.
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))


resize(cols, rows)
fds = [0, master, 3]
ctlbuf = b""
out = sys.stdout.buffer
while True:
    try:
        r, _, _ = select.select(fds, [], [])
    except InterruptedError:
        continue
    if master in r:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        if not data:
            break
        out.write(data)
        out.flush()
    if 0 in r:
        data = os.read(0, 65536)
        if not data:
            break
        os.write(master, data)
    if 3 in r:
        chunk = os.read(3, 4096)
        if not chunk:
            fds.remove(3)
        ctlbuf += chunk
        while b"\n" in ctlbuf:
            line, ctlbuf = ctlbuf.split(b"\n", 1)
            p = line.split()
            if len(p) == 3 and p[0] == b"R":
                resize(int(p[1]), int(p[2]))
try:
    os.kill(pid, signal.SIGHUP)
except OSError:
    pass
try:
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
except ChildProcessError:
    sys.exit(0)
