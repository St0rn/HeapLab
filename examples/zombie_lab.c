#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct Zombie {
    int hp;
    void (*hurt)();
    void (*eatBody)(int);
    void (*attack)();
    int living;
};
struct Human {
    int hp;
    void (*fire)(int);
    void (*prayChuckToGiveAMiracle)();
    void (*suicide)();
    int living;
};
struct Zombie *zombies[3];
struct Human *human = NULL;
void fire(int zombieIndex) {
    struct Zombie *zombie = zombies[zombieIndex];
    int hits = rand() % 10;
    zombie->hp -= hits;
    if (zombie->hp <= 0) {
        memset(zombie, 0, sizeof(struct Zombie));
        free(zombie);
        zombies[zombieIndex] = NULL;
    }
}
void prayChuckToGiveAMiracle() {
    puts("Miracle!");
    exit(0);
}
void suicide() {
    memset(human, 0, sizeof(struct Human));
    free(human);
    /* VULNERABILITE : human n'est pas remis a NULL. */
}
struct Human *newHuman() {
    struct Human *p = malloc(sizeof(struct Human));
    p->hp = 10 + rand() % 50;
    p->fire = fire;
    p->prayChuckToGiveAMiracle = prayChuckToGiveAMiracle;
    p->suicide = suicide;
    p->living = 1;
    return p;
}
void eatBody(int zombieIndex) {
    struct Zombie *p = zombies[zombieIndex];
    memset(p, 0, sizeof(struct Zombie));
    free(p);
    zombies[zombieIndex] = NULL;
}
void attack() {
    human->hp -= rand() % 10;
    if (human->hp <= 0) {
        memset(human, 0, sizeof(struct Human));
        free(human);
        human = NULL;
    }
}
struct Zombie *newZombie() {
    struct Zombie *p = malloc(sizeof(struct Zombie));
    p->hp = 10 + rand() % 40;
    p->eatBody = eatBody;
    p->attack = attack;
    p->living = 1;
    return p;
}
char getChar() {
    char ret = getc(stdin);
    char nl = getc(stdin);
    if (nl != '\n') exit(0);
    return ret;
}
int main() {
    int end = 0;
    char order = -1;
    while (!end) {
        order = getChar();
        switch (order) {
            case '1':
                if (!human) human = newHuman();
                break;
            case '2':
                if (human) {
                    int z = getChar() - 0x30;
                    if (z >= 1 && z <= 3 && zombies[z-1]) human->fire(z-1);
                }
                break;
            case '3':
                if (human) human->suicide();
                break;
            case '4':
                if (human) { memset(human, 0, sizeof(struct Human)); free(human); human = NULL; }
                break;
            case '5': {
                int z = getChar() - 0x30;
                if (z >= 1 && z <= 3 && !zombies[z-1]) zombies[z-1] = newZombie();
                break;
            }
            case '6': {
                int z = getChar() - 0x30;
                if (z >= 1 && z <= 3 && zombies[z-1] && human) zombies[z-1]->attack();
                break;
            }
            case '7': {
                int z = getChar() - 0x30;
                if (z >= 1 && z <= 3 && zombies[z-1]) zombies[z-1]->eatBody(z-1);
                break;
            }
            case '0':
            default: end = 1; break;
        }
    }
    return 0;
}
