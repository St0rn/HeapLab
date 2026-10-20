#define _GNU_SOURCE
#include <dlfcn.h>
#include <malloc.h>
#include <stdint.h>
#include <stddef.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <stdarg.h>
#include <sys/syscall.h>

/* HeapLab: diagnostics only. Linux glibc x86-64, preload-based allocation tracer.
   Records allocation events and bounded snapshots at heap API boundaries.
   NOT an isolation sandbox or a full memory access tracer. */
extern void *__libc_malloc(size_t);
extern void *__libc_calloc(size_t,size_t);
extern void *__libc_realloc(void*,size_t);
extern void __libc_free(void*);
static void *(*real_malloc)(size_t);
static void *(*real_calloc)(size_t,size_t);
static void *(*real_realloc)(void*,size_t);
static void (*real_free)(void*);
static __thread int guard = 0;
static volatile int lock = 0;
static int out_fd = -2;
static unsigned seq = 0;
#define MAX_TRACK 96
#define SNAP_BYTES 48
#define MAX_EVENTS 700
struct record { void *p; size_t req; size_t usable; int live; };
static struct record recs[MAX_TRACK];
static void acquire(void){while(__sync_lock_test_and_set(&lock,1)){while(lock){} }}
static void release(void){__sync_lock_release(&lock);}
static void initialize(void){
    if(out_fd!=-2)return;
    guard++;
    const char *e=getenv("HEAPLAB_TRACE_FD");
    out_fd=e?atoi(e):-1;
    real_malloc=dlsym(RTLD_NEXT,"malloc");
    real_calloc=dlsym(RTLD_NEXT,"calloc");
    real_realloc=dlsym(RTLD_NEXT,"realloc");
    real_free=dlsym(RTLD_NEXT,"free");
    guard--;
}
static size_t append(char *dst,size_t at,size_t cap,const char *fmt,...) {
    if(at>=cap)return cap;
    va_list ap;va_start(ap,fmt);
    int n=vsnprintf(dst+at,cap-at,fmt,ap);
    va_end(ap);
    if(n<0)return at;
    if((size_t)n>=cap-at)return cap;
    return at+(size_t)n;
}
static void track(void *ptr,size_t n){
    if(!ptr)return;
    int found=-1,freeSlot=-1;
    for(int i=0;i<MAX_TRACK;i++){
        if(recs[i].p==ptr)found=i;
        if(!recs[i].live && freeSlot<0)freeSlot=i;
    }
    int slot=found>=0?found:freeSlot;
    if(slot<0)return;
    recs[slot]=(struct record){.p=ptr,.req=n,.usable=malloc_usable_size(ptr),.live=1};
}
static void untrack(void*ptr){if(!ptr)return;for(int i=0;i<MAX_TRACK;i++)if(recs[i].p==ptr && recs[i].live){recs[i].live=0;return;}}
static void emit(const char *op,void *ptr,void *old,size_t n,size_t count){
    if(out_fd<0||seq>=MAX_EVENTS)return;
    acquire();
    if(seq>=MAX_EVENTS){release();return;}
    unsigned id=++seq;
    /* No malloc inside: local buffer and raw syscall only. */
    char buf[32768];size_t at=0;
    at=append(buf,at,sizeof(buf),"{\"seq\":%u,\"op\":\"%s\",\"ptr\":\"%p\",\"old\":\"%p\",\"size\":%zu,\"count\":%zu,\"allocations\":[",id,op,ptr,old,n,count);
    int first=1;
    for(int i=0;i<MAX_TRACK;i++){
        if(!recs[i].live||!recs[i].p)continue;
        struct record *r=&recs[i];
        if(at>sizeof(buf)-512)break;
        unsigned long long raw=0;
        /* glibc chunk size header, only for tracked libc allocations */
        raw=*(size_t*)((unsigned char*)r->p-sizeof(size_t));
        at=append(buf,at,sizeof(buf),"%s{\"ptr\":\"%p\",\"requested\":%zu,\"usable\":%zu,\"raw_size\":\"0x%llx\",\"hex\":\"",first?"":",",r->p,r->req,r->usable,raw);
        first=0;
        size_t bytes=r->req<SNAP_BYTES?r->req:SNAP_BYTES;
        const unsigned char *b=(const unsigned char*)r->p;
        for(size_t j=0;j<bytes&&at<sizeof(buf)-100;j++)at=append(buf,at,sizeof(buf),"%02x",(unsigned)b[j]);
        at=append(buf,at,sizeof(buf),"\"}");
    }
    at=append(buf,at,sizeof(buf),"]}\n");
    if(at<sizeof(buf))syscall(SYS_write,out_fd,buf,at);
    release();
}
void *malloc(size_t n){
    if(guard)return __libc_malloc(n);
    initialize();guard=1;
    void *p=(real_malloc?real_malloc(n):__libc_malloc(n));
    track(p,n);emit("malloc",p,NULL,n,1);
    guard=0;return p;
}
void *calloc(size_t num,size_t n){
    if(guard)return __libc_calloc(num,n);
    initialize();guard=1;
    void *p=(real_calloc?real_calloc(num,n):__libc_calloc(num,n));
    size_t total=(num&&n>SIZE_MAX/num)?0:num*n;
    track(p,total);emit("calloc",p,NULL,n,num);
    guard=0;return p;
}
void *realloc(void *old,size_t n){
    if(guard)return __libc_realloc(old,n);
    initialize();guard=1;
    void *p=(real_realloc?real_realloc(old,n):__libc_realloc(old,n));
    if(p||n==0)untrack(old);
    if(p)track(p,n);
    emit("realloc",p,old,n,1);
    guard=0;return p;
}
void free(void *p){
    if(guard){__libc_free(p);return;}
    initialize();guard=1;
    /* snapshot before free so the source bytes are available */
    emit("free-before",p,NULL,0,0);
    untrack(p);
    if(real_free)real_free(p);else __libc_free(p);
    emit("free",p,NULL,0,0);
    guard=0;
}
__attribute__((destructor)) static void end_trace(void){
    if(out_fd>=0&&!guard){guard=1;emit("exit",NULL,NULL,0,0);guard=0;}
}
