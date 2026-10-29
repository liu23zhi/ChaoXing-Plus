#include "json.h"

typedef struct { const char *s; int n, p, used, cap; JT *t; } JP;
static void space(JP *p) { while(p->p<p->n && (p->s[p->p]==' ' || p->s[p->p]=='\r' || p->s[p->p]=='\n' || p->s[p->p]=='\t')) p->p++; }
static int hex(char c) { if(c>='0'&&c<='9') return c-'0'; if(c>='a'&&c<='f') return c-'a'+10; if(c>='A'&&c<='F') return c-'A'+10; return -1; }
static BOOL primitive(const char*s,int p,int end) {
    int i=0;const char*word=0;if(s[p]=='t')word="true";else if(s[p]=='f')word="false";else if(s[p]=='n')word="null";
    if(word){while(word[i]){if(p+i>=end||s[p+i]!=word[i])return FALSE;i++;}return p+i==end;}
    if(s[p]=='-')p++;if(p>=end)return FALSE;
    if(s[p]=='0')p++;else{if(s[p]<'1'||s[p]>'9')return FALSE;while(p<end&&s[p]>='0'&&s[p]<='9')p++;}
    if(p<end&&s[p]=='.'){p++;i=p;while(p<end&&s[p]>='0'&&s[p]<='9')p++;if(p==i)return FALSE;}
    if(p<end&&(s[p]=='e'||s[p]=='E')){p++;if(p<end&&(s[p]=='+'||s[p]=='-'))p++;i=p;while(p<end&&s[p]>='0'&&s[p]<='9')p++;if(p==i)return FALSE;}
    return p==end;
}
static int value(JP *p, int depth) {
    int i, begin, k; char c, close;
    if(depth>64 || p->used>=p->cap) return -1;
    space(p); if(p->p>=p->n) return -1;
    i=p->used++; p->t[i].start=p->p; p->t[i].count=0; c=p->s[p->p++];
    if(c=='{' || c=='[') {
        p->t[i].type=c; close=c=='{'?'}':']'; space(p);
        if(p->p<p->n && p->s[p->p]==close) p->p++;
        else for(;;) {
            if(c=='{') {
                space(p); if(p->p>=p->n || p->s[p->p]!='"' || value(p,depth+1)<0) return -1;
                p->t[i].count++; space(p); if(p->p>=p->n || p->s[p->p++]!=':') return -1;
            }
            if(value(p,depth+1)<0) return -1; p->t[i].count++;
            space(p); if(p->p>=p->n) return -1;
            if(p->s[p->p]==close) {p->p++; break;}
            if(p->s[p->p++]!=',') return -1;
        }
    } else if(c=='"') {
        p->t[i].type='s'; begin=p->p;
        while(p->p<p->n && p->s[p->p]!='"') {
            if((unsigned char)p->s[p->p]<32) return -1;
            if(p->s[p->p++]=='\\') {
                if(p->p>=p->n) return -1;
                c=p->s[p->p++];
                if(c=='u') { for(k=0;k<4;k++) if(p->p>=p->n || hex(p->s[p->p++])<0) return -1; }
                else if(c!='"'&&c!='\\'&&c!='/'&&c!='b'&&c!='f'&&c!='n'&&c!='r'&&c!='t') return -1;
            }
        }
        if(p->p>=p->n) return -1;
        p->t[i].start=begin; p->t[i].end=p->p++; p->t[i].next=p->used; return i;
    } else {
        p->t[i].type='p'; begin=p->p-1;
        while(p->p<p->n && p->s[p->p]!=','&&p->s[p->p]!=']'&&p->s[p->p]!='}'&&p->s[p->p]!=' '&&p->s[p->p]!='\r'&&p->s[p->p]!='\n'&&p->s[p->p]!='\t') p->p++;
        if(p->p<=begin||!primitive(p->s,begin,p->p)) return -1;
    }
    p->t[i].end=p->p; p->t[i].next=p->used; return i;
}
int jparse(const char *text,int length,JT *tokens,int capacity) {
    JP p; p.s=text;p.n=length;p.p=0;p.used=0;p.cap=capacity;p.t=tokens;
    if(value(&p,0)!=0) return -1; space(&p); return p.p==p.n?p.used:-1;
}
BOOL jeq(const char *text,const JT *t,int i,const char *v) {
    int n=0,k; if(i<0)return FALSE; while(v[n])n++; if(t[i].end-t[i].start!=n)return FALSE;
    for(k=0;k<n;k++) if(text[t[i].start+k]!=v[k])return FALSE; return TRUE;
}
int jkey(const char *text,const JT *t,int o,const char *key) {
    int i; if(o<0||t[o].type!='{')return -1;
    for(i=o+1;i<t[o].next;) { int v=i+1; if(jeq(text,t,i,key))return v; i=t[v].next; } return -1;
}
int jint(const char *s,const JT *t,int i,int fallback) {
    int p,digit;DWORD n=0,limit=2147483647UL;BOOL negative=FALSE;if(i<0||t[i].type!='p')return fallback;p=t[i].start;
    if(s[p]=='-'){negative=TRUE;limit++;p++;}if(p>=t[i].end)return fallback;
    for(;p<t[i].end;p++){digit=s[p]-'0';if(digit<0||digit>9||n>(limit-(DWORD)digit)/10)return fallback;n=n*10+(DWORD)digit;}
    return negative?(int)(0UL-n):(int)n;
}
BOOL jwstr(const char *s,const JT *t,int i,WCHAR *out,int cap) {
    int p,n=0,b,k,r; WCHAR c; if(cap<1)return FALSE; out[0]=0;if(i<0||t[i].type!='s')return FALSE;
    p=t[i].start;
    while(p<t[i].end && n<cap-1) {
        if(s[p]=='\\') {
            p++;c=(WCHAR)(unsigned char)s[p++];
            if(c=='u'){c=0;for(k=0;k<4;k++)c=(WCHAR)(c*16+hex(s[p++]));}
            else if(c=='n')c='\n';else if(c=='r')c='\r';else if(c=='t')c='\t';else if(c=='b')c='\b';else if(c=='f')c='\f';
            out[n++]=c;
        } else {
            unsigned char first=(unsigned char)s[p];b=p;k=first<128?1:first<224?2:first<240?3:4;
            if(p+k>t[i].end){out[n]=0;return FALSE;}p+=k;
            r=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s+b,k,out+n,cap-n-1);
            if(!r) {out[n]=0;return FALSE;} n+=r;
        }
    }
    out[n]=0;return p==t[i].end;
}
BOOL jstr(const char *s,const JT *t,int i,char *out,int cap) {
    WCHAR *w; BOOL ok,truncated=FALSE; int n=0,p=0,r,units;char encoded[8];if(cap<1)return FALSE;out[0]=0;
    w=(WCHAR*)HeapAlloc(GetProcessHeap(),0,(SIZE_T)cap*sizeof(WCHAR));if(!w)return FALSE;
    ok=jwstr(s,t,i,w,cap);
    while(w[p]){
        units=(w[p]>=0xd800&&w[p]<=0xdbff&&w[p+1]>=0xdc00&&w[p+1]<=0xdfff)?2:1;
        r=WideCharToMultiByte(CP_UTF8,0,w+p,units,encoded,sizeof(encoded),0,0);
        if(r<=0||n+r>=cap){truncated=TRUE;break;}
        {int k;for(k=0;k<r;k++)out[n++]=encoded[k];}p+=units;
    }
    out[n]=0;HeapFree(GetProcessHeap(),0,w);return ok&&!truncated;
}


