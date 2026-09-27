// Packed expression programs for the less common geometry constraints. Programs
// are compiled once by the model adapter. Evaluation and reverse differentiation
// run entirely here, using resident scratch arrays and the existing sparse CSR.
// The original direct kernels remain the fast path for basic line/point models.
extern "C" double sin(double), cos(double), atan2(double, double), fmod(double, double), hypot(double, double), floor(double);
struct Instruction { i32 op, a, b, c; };
enum Op { Literal, VariableValue, ParameterValue, Add, Subtract, Multiply, Divide,
  Negate, Absolute, SquareRoot, Hypotenuse, Sine, Cosine, ArcTangent, ModTau,
  Minimum, Maximum, Less, LessEqual, Greater, GreaterEqual, Select,
  NormalizedDifference, NormalizedScale, RoundNine, Guard, DependentValue, SwellValue };
static Instruction* instructions;
static double *programData, *programValues, *adjoints;
static i32 programCount, programCapacity;
static constexpr double tau=6.283185307179586476925286766559;

static bool runProgram(const Constraint& c) {
  bool analytical=c.refs[6]==0;
  for(i32 i=0;i<c.refs[1];++i) {
    const auto& op=instructions[c.refs[0]+i];
    const double a=op.op>ParameterValue && op.op!=DependentValue && op.op!=SwellValue && op.a>=0?programValues[op.a]:0,
      b=op.op>ParameterValue && op.op!=SwellValue && op.b>=0?programValues[op.b]:0;
    double v=0;
    switch(op.op) {
      case Literal:v=programData[c.refs[0]+i];break;
      case VariableValue:v=x[op.a];break;
      case DependentValue:v=x[op.a];break;
      case ParameterValue:v=parameters[op.a];break;
      case SwellValue:v=swell::value(op.a,op.b);break;
      case Add:v=a+b;break;case Subtract:v=a-b;break;case Multiply:v=a*b;break;case Divide:v=a/b;break;
      case Negate:v=-a;break;case Absolute:v=absd(a);break;
      case SquareRoot:v=root(a);break;
      case Hypotenuse:v=hypot(a,b);break;
      case Sine:v=sin(a);break;case Cosine:v=cos(a);break;
      case ArcTangent:v=atan2(a,b);break;
      case ModTau:v=fmod(a+tau,tau);break;
      case Minimum:v=(a!=a || b!=b)?__builtin_nan(""):mind(a,b);break;
      case Maximum:v=(a!=a || b!=b)?__builtin_nan(""):maxd(a,b);break;
      case Less:v=a<b;break;case LessEqual:v=a<=b;break;case Greater:v=a>b;break;case GreaterEqual:v=a>=b;break;
      case Select:v=a?b:programValues[op.c];break;
      case NormalizedDifference: {
        const double s=maxd(1,maxd(absd(a),absd(b))), t=1e-9*s;
        v=(a-b)/s;
        if(!(absd(a-b)<=t && s>1+t) &&
            ((absd(absd(a)-s)<=t && absd(absd(a)-1)<=t) ||
             (absd(absd(a)-s)>t && absd(absd(b)-s)<=t && absd(absd(b)-1)<=t))) analytical=false;
        break;
      }
      case NormalizedScale:v=a/maxd(1,absd(b));if(absd(b-1)<=1e-9*maxd(1,absd(b)))analytical=false;break;
      case RoundNine:v=floor(a*1e9+0.5)/1e9;break;
      case Guard:v=a;if(!a)analytical=false;break;
    }
    programValues[i]=v;
  }
  return analytical;
}
static bool differentiateProgram(const Constraint& c, i32 row) {
  zero(adjoints,c.refs[1]);adjoints[c.refs[2+row]]=1;
  for(i32 i=c.refs[1]-1;i>=0;--i) {
    const double g=adjoints[i];if(g==0)continue;
    const auto& op=instructions[c.refs[0]+i];
    const double a=op.op>ParameterValue && op.op!=DependentValue && op.op!=SwellValue && op.a>=0?programValues[op.a]:0,
      b=op.op>ParameterValue && op.op!=SwellValue && op.b>=0?programValues[op.b]:0, v=programValues[i];
    double da=0,db=0;
    switch(op.op) {
      case VariableValue:
        for(i32 e=rowOffsets[c.row+row];e<rowOffsets[c.row+row+1];++e) if(active[columns[e]]==op.a)values[e]+=g;
        continue;
      case DependentValue:adjoints[op.b]+=g;continue;
      case SwellValue:return false;
      case Add:da=db=1;break;case Subtract:da=1;db=-1;break;
      case Multiply:da=b;db=a;break;case Divide:da=1/b;db=-a/(b*b);break;
      case Negate:da=-1;break;case Absolute:da=sign(a)?sign(a):1;break;
      case SquareRoot:if(v<1e-9)return false;da=0.5/v;break;
      case Hypotenuse:if(v<1e-9)return false;da=a/v;db=b/v;break;
      case Sine:da=cos(a);break;case Cosine:da=-sin(a);break;
      case ArcTangent:if(a*a+b*b<1e-18)return false;da=b/(a*a+b*b);db=-a/(a*a+b*b);break;
      case ModTau:case RoundNine:da=1;break;
      case Minimum:if(a<=b)da=1;else db=1;break;
      case Maximum:if(a>b)da=1;else db=1;break;
      case Select:adjoints[a?op.b:op.c]+=g;continue;
      case NormalizedDifference: {
        const double s=maxd(1,maxd(absd(a),absd(b))),t=1e-9*s;
        double sa=0,sb=0;
        if(absd(a-b)<=t && s>1+t) {}
        else if(absd(absd(a)-s)<=t)sa=sign(a);
        else if(absd(absd(b)-s)<=t)sb=sign(b);
        da=1/s-(a-b)*sa/(s*s);db=-1/s-(a-b)*sb/(s*s);break;
      }
      case NormalizedScale: {const double s=maxd(1,absd(b));da=1/s;db=absd(b)>1?-a*sign(b)/(s*s):0;break;}
      default:continue;
    }
    if(da!=0)adjoints[op.a]+=g*da;
    if(db!=0)adjoints[op.b]+=g*db;
  }
  return true;
}
static bool evaluateProgram(const Constraint& c,double* output,bool derivatives) {
  bool analytical=runProgram(c);
  for(i32 r=0;r<c.rows;++r) {
    const double v=programValues[c.refs[2+r]];
    if(!finite(v))return false;
    output[c.row+r]=v;
  }
  if(!derivatives)return true;
  if(analytical)for(i32 r=0;r<c.rows;++r)if(!differentiateProgram(c,r)){analytical=false;break;}
  if(analytical) ++analyticCount;
  else {
    ++fallbackCount;
    for(i32 e=rowOffsets[c.row];e<rowOffsets[c.row+1];++e) {
      const i32 variable=active[columns[e]];
      const double original=x[variable],delta=1e-6*maxd(1,absd(original));
      // Apply the same reduced-coordinate chain rule as reduceBlocks. A trial
      // endpoint perturbation also moves every dependent center by its weight.
      for(i32 p=0;p<projectionCount;++p) {
        const i32* dependency=projections+p*3;
        const double weight=.5*((dependency[1]==variable)+(dependency[2]==variable));
        if(weight){projectionTrialValues[p]=x[dependency[0]];x[dependency[0]]=projectionTrialValues[p]+weight*delta;}
      }
      double plus[3];x[variable]=original+delta;runProgram(c);
      for(i32 r=0;r<c.rows;++r)plus[r]=programValues[c.refs[2+r]];
      for(i32 p=0;p<projectionCount;++p) {
        const i32* dependency=projections+p*3;const double weight=.5*((dependency[1]==variable)+(dependency[2]==variable));
        if(weight)x[dependency[0]]=projectionTrialValues[p]-weight*delta;
      }
      x[variable]=original-delta;runProgram(c);
      for(i32 r=0;r<c.rows;++r)values[rowOffsets[c.row+r]+e-rowOffsets[c.row]]=(plus[r]-programValues[c.refs[2+r]])/(2*delta);
      x[variable]=original;
      for(i32 p=0;p<projectionCount;++p) {
        const i32* dependency=projections+p*3;
        if(dependency[1]==variable||dependency[2]==variable)x[dependency[0]]=projectionTrialValues[p];
      }
    }
  }
  for(i32 e=rowOffsets[c.row];e<rowOffsets[c.row+c.rows];++e)if(!finite(values[e]))return false;
  return true;
}
