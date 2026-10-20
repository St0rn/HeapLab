/*
 * HeapLab - démonstration locale et non exploitable à distance.
 * Le pointeur de fonction est DANS le même objet alloué sur le heap.
 * L'overflow dépasse le membre data[32], pas nécessairement l'allocation.
 * gcc -g -O0 -o control_flow_lab control_flow_lab.c
 */
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void (*callback_t)(void);
struct Session {
    char data[32];
    callback_t handler;
};

static void safe_callback(void) { puts("[LAB] callback normale"); }
static void win(void) { puts("[LAB] contrôle du flot: win() appelée"); }

int main(void) {
    struct Session *s = malloc(sizeof *s);
    if (!s) return 1;
    s->handler = safe_callback;
    puts("Avant modification:");
    s->handler();

    /* Cette charge utile est construite localement : pas de saisie externe. */
    unsigned char input[sizeof *s];
    memset(input, 'A', sizeof input);
    callback_t replacement = win;
    memcpy(input + offsetof(struct Session, handler), &replacement, sizeof replacement);

    /* Vulnérabilité volontaire : écriture au-delà du champ data[32]. */
    memcpy(s->data, input, sizeof input);
    puts("Après écrasement du champ handler:");
    s->handler();

    free(s);
    return 0;
}
