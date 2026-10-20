#include <cstdlib>
#include <cstring>
struct User { int id; char *name; bool active; };
int main(int argc, char **argv) {
    User *first = new User;
    first->id = 42;
    first->active = true;
    char *buffer = new char[24];
    strcpy(buffer, argv[1]);
    delete[] buffer;
    delete first;
    User *second = new User;
    second->id = 7;
    delete second;
    return 0;
}
