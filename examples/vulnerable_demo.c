/* Educational demo: for ASan verification, not for production use. */
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
int main(int argc, char **argv) {
    if (argc < 2) { fputs("Usage: demo STRING\n", stderr); return 1; }
    char *a = malloc(24);
    char *b = malloc(32);
    if (!a || !b) return 2;
    strcpy(a, argv[1]);  /* Unsafe by design: run with ASan in a VM. */
    printf("A: %s\n", a);
    free(a);
    free(b);
    return 0;
}
