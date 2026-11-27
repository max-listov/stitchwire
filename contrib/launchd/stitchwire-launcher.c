/*
 * Stitchwire macOS launchd supervisor (`Stitchwire.app/Contents/MacOS/stitchwire-launcher`).
 *
 * Placed as the first entry in ProgramArguments of Stitchwire LaunchAgents so macOS attributes
 * background local-network and privacy identity to the signed Stitchwire.app bundle instead of
 * an unsigned or generic interpreter binary.
 *
 * Stays the parent process (posix_spawnp without POSIX_SPAWN_SETEXEC and without responsibility
 * disclaim) and is transparent to launchd: every signal it can safely catch is forwarded to the
 * child, and the child's end becomes the launcher's own — the same exit status, or death by the
 * same signal, so launchd records a crash or a kill as one.
 *
 * Boundary: a production build refuses to run unless its parent is launchd (getppid() == 1), so a
 * command typed in a shell never runs under the bundle's identity. That is the whole guarantee.
 * Any launchd job of the same user, or a process orphaned before main, can start the launcher with
 * any program. An allowlist of programs would not narrow this: the programs Stitchwire runs are a
 * general interpreter (Bun) loading a user-writable script, and the job that starts it also
 * chooses the working directory (`bunfig.toml` preloads) and the environment. The bundle's
 * identity is exactly as trusted as the user account that installs it.
 */
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static volatile sig_atomic_t child_pid = 0;

/*
 * Not forwarded: SIGKILL and SIGSTOP cannot be caught; SIGCHLD reports our own child. SIGSEGV, SIGBUS,
 * SIGILL, SIGFPE and SIGTRAP keep their default action, so a fault in the launcher ends it: macOS
 * reports these signals sent by kill() with the same si_code and si_pid as a real fault, and a
 * handler returning from a real one would run the faulting instruction again forever.
 */
static int is_forwardable(int signo) {
  switch (signo) {
    case SIGKILL:
    case SIGSTOP:
    case SIGCHLD:
    case SIGSEGV:
    case SIGBUS:
    case SIGILL:
    case SIGFPE:
    case SIGTRAP:
      return 0;
    default:
      return 1;
  }
}

static void forward_signal(int signo) {
  int saved_errno = errno;
  pid_t pid = (pid_t)child_pid;
  if (pid > 0) kill(pid, signo);
  errno = saved_errno;
}

/* End the launcher the way its child ended; returns only if the signal did not terminate it. */
static int die_like_child(int signo) {
  struct sigaction fallback;
  memset(&fallback, 0, sizeof fallback);
  fallback.sa_handler = SIG_DFL;
  sigemptyset(&fallback.sa_mask);
  sigaction(signo, &fallback, NULL);
  sigset_t only;
  sigemptyset(&only);
  sigaddset(&only, signo);
  sigprocmask(SIG_UNBLOCK, &only, NULL);
  raise(signo);
  return 128 + signo;
}

/* The child must not outlive a launcher that cannot supervise it. */
static int abandon_child(pid_t pid) {
  kill(pid, SIGKILL);
  int status = 0;
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
  }
  return 126;
}

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "usage: stitchwire-launcher <program> [args...]\n");
    return 2;
  }

#ifndef STITCHWIRE_LAUNCHER_ALLOW_NON_LAUNCHD
  if (getppid() != 1) {
    fprintf(
      stderr,
      "stitchwire-launcher: refused — must be launched directly by launchd (ppid=1, got %d)\n",
      (int)getppid()
    );
    return 125;
  }
#endif

  /* Forward every catchable signal, except those already ignored: the child inherits that choice. */
  sigset_t forwarded;
  sigemptyset(&forwarded);
  for (int signo = 1; signo < NSIG; signo++) {
    if (!is_forwardable(signo)) continue;
    struct sigaction inherited;
    if (sigaction(signo, NULL, &inherited) != 0) {
      fprintf(stderr, "stitchwire-launcher: sigaction(%d) query: %s\n", signo, strerror(errno));
      return 126;
    }
    if (inherited.sa_handler != SIG_IGN) sigaddset(&forwarded, signo);
  }

  /* Block signals before installing handlers so none are lost before child_pid is published. */
  sigset_t previous;
  if (sigprocmask(SIG_BLOCK, &forwarded, &previous) != 0) {
    fprintf(stderr, "stitchwire-launcher: sigprocmask(SIG_BLOCK): %s\n", strerror(errno));
    return 126;
  }

  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = forward_signal;
  action.sa_mask = forwarded;
  for (int signo = 1; signo < NSIG; signo++) {
    if (!sigismember(&forwarded, signo)) continue;
    if (sigaction(signo, &action, NULL) != 0) {
      fprintf(stderr, "stitchwire-launcher: sigaction(%d): %s\n", signo, strerror(errno));
      return 126;
    }
  }

  posix_spawnattr_t attrs;
  int rc = posix_spawnattr_init(&attrs);
  if (rc != 0) {
    fprintf(stderr, "stitchwire-launcher: posix_spawnattr_init: %s\n", strerror(rc));
    return 126;
  }
  rc = posix_spawnattr_setsigmask(&attrs, &previous);
  if (rc != 0) {
    posix_spawnattr_destroy(&attrs);
    fprintf(stderr, "stitchwire-launcher: posix_spawnattr_setsigmask: %s\n", strerror(rc));
    return 126;
  }
  rc = posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETSIGMASK);
  if (rc != 0) {
    posix_spawnattr_destroy(&attrs);
    fprintf(stderr, "stitchwire-launcher: posix_spawnattr_setflags: %s\n", strerror(rc));
    return 126;
  }

  pid_t pid = 0;
  int failure = posix_spawnp(&pid, argv[1], NULL, &attrs, &argv[1], environ);
  posix_spawnattr_destroy(&attrs);
  if (failure != 0) {
    fprintf(stderr, "stitchwire-launcher: cannot start %s: %s\n", argv[1], strerror(failure));
    return 127;
  }

  child_pid = pid;
  if (sigprocmask(SIG_SETMASK, &previous, NULL) != 0) {
    fprintf(stderr, "stitchwire-launcher: sigprocmask(SIG_SETMASK): %s\n", strerror(errno));
    return abandon_child(pid);
  }

  /* Wait without reaping, so a forwarded signal can never reach a recycled PID. */
  siginfo_t ended;
  for (;;) {
    memset(&ended, 0, sizeof ended);
    if (waitid(P_PID, (id_t)pid, &ended, WEXITED | WNOWAIT) == 0) break;
    if (errno != EINTR) {
      fprintf(stderr, "stitchwire-launcher: waitid: %s\n", strerror(errno));
      return abandon_child(pid);
    }
  }
  if (sigprocmask(SIG_BLOCK, &forwarded, NULL) != 0) {
    fprintf(stderr, "stitchwire-launcher: sigprocmask(SIG_BLOCK): %s\n", strerror(errno));
    return abandon_child(pid);
  }
  child_pid = 0;

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) {
      fprintf(stderr, "stitchwire-launcher: waitpid: %s\n", strerror(errno));
      return 126;
    }
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return die_like_child(WTERMSIG(status));
  return 1;
}
