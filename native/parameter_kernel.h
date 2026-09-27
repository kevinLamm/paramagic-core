extern "C" double pow(double,double), tan(double), asin(double), acos(double), atan(double), ceil(double);
namespace expression {
struct Op {i32 kind,a,b,c;};
static i32 capacityE,capacityI,entries,instructionsCount,*records,*types,*nodeTypes;
static Op* code;static double *inputs,*data,*nodes,*scales;
// ECMAScript rejects unit-magnitude bases with an infinite exponent.
static double power(double base,double exponent){return absd(base)==1&&!finite(exponent)?__builtin_nan(""):pow(base,exponent);}
}
extern "C" __attribute__((visibility("default"))) i32 expression_configure(i32 entries,i32 instructions){
  using namespace expression;
  if(entries<0||entries>1000000||instructions<0||instructions>16000000)return 0;
  expression::entries=entries;instructionsCount=instructions;
  if(records&&entries<=capacityE&&instructions<=capacityI)return 1;
  capacityE=maxd(entries,capacityE*2);capacityI=maxd(instructions,capacityI*2);
  cursor=reinterpret_cast<u32>(&__heap_base);
  records=reserve<i32>(capacityE*5);types=reserve<i32>(capacityE);inputs=reserve<double>(capacityE);scales=reserve<double>(capacityE);
  code=reserve<expression::Op>(capacityI);data=reserve<double>(capacityI);nodes=reserve<double>(capacityI);nodeTypes=reserve<i32>(capacityI);
  const u32 current=__builtin_wasm_memory_size(0),required=(cursor+65535)/65536;
  if(required<=current||__builtin_wasm_memory_grow(0,required-current)!=static_cast<unsigned long>(-1))return 1;
  capacityE=capacityI=0;records=nullptr;return 0;
}
extern "C" __attribute__((visibility("default"))) u32 expression_buffer(i32 kind){
  using namespace expression;void* buffers[]={records,types,inputs,scales,code,data};return kind>=0&&kind<6?reinterpret_cast<u32>(buffers[kind]):0;
}
extern "C" __attribute__((visibility("default"))) i32 expression_evaluate(){
  using namespace expression;constexpr double degree=3.14159265358979323846/180;
  for(i32 e=0;e<entries;++e){
    const i32 *record=records+e*5;if(!record[4])continue;
    for(i32 i=record[1];i<record[1]+record[2];++i){
      const auto op=code[i];const double a=op.a>=0&&op.kind>1?nodes[op.a]:0,b=op.b>=0?nodes[op.b]:0,c=op.c>=0?nodes[op.c]:0;
      double v=0;i32 type=0;
      switch(op.kind){
        case 0:v=data[i];type=op.a;break;
        case 1:v=inputs[op.a];type=types[op.a];if(!type)v*=data[i];break;
        case 2:v=a+b;break;case 3:v=a-b;break;case 4:v=a*b;break;case 5:v=a/b;break;case 6:v=power(a,b);break;
        case 7:v=a<b;type=1;break;case 8:v=a<=b;type=1;break;case 9:v=a>b;type=1;break;case 10:v=a>=b;type=1;break;
        case 11:v=a==b&&nodeTypes[op.a]==nodeTypes[op.b];type=1;break;case 12:v=a!=b||nodeTypes[op.a]!=nodeTypes[op.b];type=1;break;
        case 13:v=(a!=0&&!__builtin_isnan(a))&&(b!=0&&!__builtin_isnan(b));type=1;break;
        case 14:v=(a!=0&&!__builtin_isnan(a))||(b!=0&&!__builtin_isnan(b));type=1;break;
        case 15:v=-a;break;case 16:v=a;break;case 17:v=a==0||__builtin_isnan(a);type=1;break;
        case 18:v=absd(a);break;
        case 19:v=__builtin_isnan(a)||__builtin_isnan(b)?__builtin_nan(""):a==b?(a==0&&(__builtin_signbit(a)||__builtin_signbit(b))?-0.0:a):mind(a,b);break;
        case 20:v=__builtin_isnan(a)||__builtin_isnan(b)?__builtin_nan(""):a==b?(a==0&&(!__builtin_signbit(a)||!__builtin_signbit(b))?0.0:a):maxd(a,b);break;
        case 21:{double f=floor(a);v=a<0&&a>=-.5?-0.0:(a-f<.5?f:f+1);break;}
        case 22:v=floor(a);break;case 23:v=ceil(a);break;case 24:v=root(a);break;case 25:v=power(a,b);break;
        case 26:v=sin(a*degree);break;case 27:v=cos(a*degree);break;case 28:v=tan(a*degree);break;
        case 29:v=asin(a)/degree;break;case 30:v=acos(a)/degree;break;case 31:v=atan(a)/degree;break;
        case 32:{bool t=a!=0&&!__builtin_isnan(a);v=t?b:c;type=nodeTypes[t?op.b:op.c];break;}
        case 33:if(!finite(a)||!finite(b)||!finite(c))return 0;v=mind(maxd(a,b),maxd(mind(a,b),c));break;
        case 34:v=a;type=nodeTypes[op.a];if(!type&&!finite(v))return 0;break;
        default:return 0;
      }
      nodes[i]=v;nodeTypes[i]=type;
    }
    const i32 output=record[3],id=record[0];double value=nodes[output];
    if(!nodeTypes[output])value*=scales[id];if(!finite(value))return 0;
    inputs[id]=value;types[id]=nodeTypes[output];
  }
  return 1;
}
