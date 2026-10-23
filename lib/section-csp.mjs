/** Only a permissive, observed script policy can authorize a new bare inline script. */
export function permitsBareInline(policy) {
  if(policy?.complete!==true||!Array.isArray(policy.headers)||!Array.isArray(policy.meta))return false;
  return [...policy.headers,...policy.meta].every(value=>{
    if(typeof value!=='string'||value.length>65536)return false;
    // Multiple enforced policies intersect, including comma-combined header values.
    return value.split(',').every(part=>{
      const directives=new Map();
      for(const clause of part.split(';')) {const [name,...tokens]=clause.trim().split(/\s+/);if(!directives.has(name.toLowerCase()))directives.set(name.toLowerCase(),tokens);}
      if(directives.has('sandbox')&&!directives.get('sandbox').includes('allow-scripts'))return false;
      const tokens=directives.get('script-src-elem')??directives.get('script-src')??directives.get('default-src');
      return !tokens||tokens.includes("'unsafe-inline'")&&!tokens.some(t=>/^'(?:nonce-|sha(?:256|384|512)-|strict-dynamic')/.test(t));
    });
  });
}
