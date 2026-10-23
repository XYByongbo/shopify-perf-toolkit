import { deflateSync } from 'node:zlib';
// Deterministic test pixels, generated in memory. No merchant media is copied.
export function fixturePNG(width=800,height=400) {
  const crc=buffer=>{let c=0xffffffff;for(const b of buffer){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
  const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(body));return Buffer.concat([length,body,checksum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc(height*(1+width*3));
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(width*3+1)+1+x*3;pixels[i]=x%256;pixels[i+1]=y%256;pixels[i+2]=(x*y)%256;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
