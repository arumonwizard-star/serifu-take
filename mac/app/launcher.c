/* セリフテイク.app の本体（起動役）。
   Mac の許可（外付けディスクなど）を「セリフテイク」として受けるため、
   このプログラムが親として残り、起動スクリプトを子として動かす。
   ヘッダが無い環境でも作れるように、必要な関数は自前で宣言する。 */
typedef int pid_t_;
extern int posix_spawn(pid_t_ *, const char *, const void *, const void *, char *const[], char *const[]);
extern int waitpid(pid_t_, int *, int);
extern int _NSGetExecutablePath(char *, unsigned int *);
extern char *realpath(const char *, char *);
extern char *dirname(char *);
extern int snprintf(char *, unsigned long, const char *, ...);
extern char **environ;
int main(void) {
  char p[4096], r[4096], s[4096];
  unsigned int n = sizeof p;
  if (_NSGetExecutablePath(p, &n) != 0 || !realpath(p, r)) return 1;
  snprintf(s, sizeof s, "%s/../Resources/launch.sh", dirname(r));
  char *args[] = {"/bin/bash", s, 0};
  pid_t_ pid;
  if (posix_spawn(&pid, "/bin/bash", 0, 0, args, environ) != 0) return 1;
  int st = 0;
  while (waitpid(pid, &st, 0) < 0) {}
  return (st & 0x7f) == 0 ? (st >> 8) & 0xff : 1;
}
