#include <stdlib.h>
#include <string.h>
#include <stdio.h>
int main(int argc, char**argv){
  char *a=malloc(24); char *b=malloc(32);
  if (!a||!b)return 2;
  const char *value=argc>1?argv[1]:"HELLO";
  snprintf(a,24,"%s",value);
  free(a);
  char *c=malloc(16);
  strcpy(c,"OK");
  puts(c);
  free(b);free(c);
  return 0;
}
