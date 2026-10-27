import os, sys, pty, select, fcntl, termios, struct, signal, pwd

# argv: cwd cols rows.  fd0 = keyboard bytes in, fd1 = pty bytes out, fd3 = control lines ("R cols rows").
cwd = sys.argv[1] if len(sys.argv) > 1 else ""
cols = int(sys.argv[2]) if len(sys.argv) > 2 else 80
rows = int(sys.argv[3]) if len(sys.argv) > 3 else 24

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

pid, master = pty.fork()
if pid == 0:
    try:
        os.chdir(cwd if cwd and os.path.isdir(cwd) else pw.pw_dir)
    except OSError:
        pass
    os.execvpe(shell, [shell, "-l"], env)


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
