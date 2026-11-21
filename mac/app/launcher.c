/* セリフテイク.app の本体（起動役）。
   Mac の許可（外付けディスクなど）を「セリフテイク」として受けるため、
   このプログラムが親として残り、起動スクリプトを子として動かす。 */
#include <spawn.h>
#include <sys/wait.h>
#include <mach-o/dyld.h>
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <stdint.h>
extern char **environ;
int main(void) {
  char p[PATH_MAX], r[PATH_MAX], s[PATH_MAX];
  uint32_t n = sizeof p;
  if (_NSGetExecutablePath(p, &n) != 0 || !realpath(p, r)) return 1;
  snprintf(s, sizeof s, "%s/../Resources/launch.sh", dirname(r));
  char *args[] = {"/bin/bash", s, NULL};
  pid_t pid;
  if (posix_spawn(&pid, "/bin/bash", NULL, NULL, args, environ) != 0) return 1;
  int st = 0;
  while (waitpid(pid, &st, 0) < 0) {}
  return WIFEXITED(st) ? WEXITSTATUS(st) : 1;
}
