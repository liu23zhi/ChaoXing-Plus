void * __cdecl memset(void *dest, int value, unsigned int count) {
    volatile unsigned char *p = (volatile unsigned char *)dest;
    while (count--) *p++ = (unsigned char)value;
    return dest;
}

void * __cdecl memcpy(void *dest, const void *source, unsigned int count) {
    volatile unsigned char *p = (volatile unsigned char *)dest;
    const unsigned char *s = (const unsigned char *)source;
    while (count--) *p++ = *s++;
    return dest;
}


