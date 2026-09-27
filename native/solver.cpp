// ParaMagic's LM/PCG equations, in persistent packed memory. No runtime, WASI,
// allocator, threads, external solver, or JS callbacks are used by this module.
// The ABI is owned by WasmSolverSession.js. All floating point is IEEE Float64.
using u32 = unsigned int;
using i32 = int;
extern "C" unsigned char __heap_base;
extern "C" void* memset(void* destination, int value, unsigned long size) {
  auto p = static_cast<unsigned char*>(destination);
  for (unsigned long i = 0; i < size; ++i) p[i] = static_cast<unsigned char>(value);
  return destination;
}
extern "C" void* memcpy(void* destination, const void* source, unsigned long size) {
  auto d = static_cast<unsigned char*>(destination); auto s = static_cast<const unsigned char*>(source);
  for (unsigned long i = 0; i < size; ++i) d[i] = s[i];
  return destination;
}
static double absd(double x) { return __builtin_fabs(x); }
static double maxd(double a, double b) { return a > b ? a : b; }
static double mind(double a, double b) { return a < b ? a : b; }
static double sign(double x) { return x < 0 ? -1 : x > 0 ? 1 : 0; }
static bool finite(double x) { return __builtin_isfinite(x); }
static double root(double x) { return __builtin_sqrt(x); }

enum Kind { Coincident=1, Horizontal, Vertical, Distance, HorizontalDistance,
  VerticalDistance, Fixed, Radius, Diameter, Midpoint, Concentric, PointOnCircle };
enum Status { Running=0, Converged=1, Unchanged=2, MaxIterations=3, Invalid=4, Cancelled=5, Preview=6, Failed=7 };
struct Constraint { i32 kind, row, rows, parameter; i32 refs[8]; };
static_assert(sizeof(Constraint) == 48);
struct Constants { double target, fixedX, fixedY, directionX, directionY, orientation; };
static_assert(sizeof(Constants) == 48);

static u32 pointers[24], cursor, bytes, grows, topologyBuilds;
static i32 nv, n, nc, nr, nz, np, ng, ne;
static double *x, *initial, *accepted, *parameters, *values, *errors, *candidate;
static double *diagonal, *damping, *normal, *factors, *step, *rhs, *residual, *z, *direction, *product, *rowWork;
static i32 *active, *rowOffsets, *columns, *groupStarts, *groupColumns, *groupOffsets, *columnGroups, *columnLocal;
static Constraint* constraints;
static Constants* constants;
static double stats[20];
static double lambda, error, initialError, threshold, targetNorm, rz;
static i32 status, phase, outer, acceptedSteps, rejectedSteps, inner, totalInner, lastInner, maxOuter, maxInner, interactive;
static i32 analyticCount, fallbackCount;
static i32 terminationReason;
static bool lastLinearConverged;
static i32 *projections, *seedIndices, projectionCount, seedCount;
static double *seedValues, *projectionTrialValues;
static bool projectEnabled;

template<class T> static T* reserve(u32 count) {
  cursor = (cursor + 7u) & ~7u;
  auto result = reinterpret_cast<T*>(cursor);
  cursor += count * sizeof(T);
  return result;
}
static void zero(double* data, i32 count) { for (i32 i=0; i<count; ++i) data[i]=0; }
static void copy(double* to, const double* from, i32 count) { for (i32 i=0; i<count; ++i) to[i]=from[i]; }
static double dot(const double* a, const double* b, i32 count) { double v=0; for(i32 i=0;i<count;++i) v+=a[i]*b[i]; return v; }
static double coordinate(i32 index) { return index < 0 ? 0 : x[index]; }
static void applyJ(const double*,double*);
static void applyJT(const double*,double*);
#include "swell_geometry.h"
#include "constraint_program.h"
#include "sparse_elimination.h"
#include "graph_kernel.h"
#include "parameter_kernel.h"
#include "continuation.h"

extern "C" __attribute__((visibility("default"))) i32 configure(i32 variables, i32 activeCount, i32 constraintCount,
  i32 rows, i32 entries, i32 parameterCount, i32 groups, i32 normalEntries, i32 instructionCount, i32 instructionCapacity,
  i32 dependentCount, i32 initialSeedCount, i32 swellSources, i32 swellRefs, i32 swellDefinitions,
  i32 swellPairs, i32 swellRequests, i32 swellSegments, i32 swellSamples, i32 sparseEntries) {
  // Reject malformed or overflow-sized input before forming pointers.
  if (variables<0 || variables>2000000 || activeCount<0 || activeCount>variables || constraintCount<0 || constraintCount>1000000
      || rows<0 || rows>2000000 || entries<0 || entries>16000000 || parameterCount<0 || parameterCount>1000000
      || groups<0 || groups>activeCount || normalEntries<0 || normalEntries>activeCount*8
      || instructionCount<0 || instructionCount>20000000 || instructionCapacity<0 || instructionCapacity>100000
      || dependentCount<0 || dependentCount>variables || initialSeedCount<0 || initialSeedCount>variables
      || swellSources<0 || swellSources>100000 || swellRefs<0 || swellRefs>2000000
      || swellDefinitions<0 || swellDefinitions>200000 || swellPairs<0 || swellPairs>1000000
      || swellRequests<0 || swellRequests>1000000 || swellSegments<0 || swellSegments>200000
      || swellSamples<0 || swellSamples>2000000 || sparseEntries<0 || sparseEntries>65536
      || (sparseEntries && (activeCount>2048 || sparseEntries<activeCount))) return 0;
  nv=variables; n=activeCount; nc=constraintCount; nr=rows; nz=entries; np=parameterCount; ng=groups; ne=normalEntries;
  cursor = reinterpret_cast<u32>(&__heap_base);
  x=reserve<double>(nv); initial=reserve<double>(nv); accepted=reserve<double>(nv);
  parameters=reserve<double>(np); constraints=reserve<Constraint>(nc); constants=reserve<Constants>(nc);
  active=reserve<i32>(n); rowOffsets=reserve<i32>(nr+1); columns=reserve<i32>(nz); values=reserve<double>(nz);
  errors=reserve<double>(nr); candidate=reserve<double>(nr);
  groupStarts=reserve<i32>(ng+1); groupColumns=reserve<i32>(n); groupOffsets=reserve<i32>(ng+1);
  columnGroups=reserve<i32>(n); columnLocal=reserve<i32>(n); normal=reserve<double>(ne); factors=reserve<double>(ne);
  diagonal=reserve<double>(n); damping=reserve<double>(n); step=reserve<double>(n); rhs=reserve<double>(n);
  residual=reserve<double>(n); z=reserve<double>(n); direction=reserve<double>(n); product=reserve<double>(n); rowWork=reserve<double>(nr);
  programCount=instructionCount;programCapacity=instructionCapacity;
  instructions=reserve<Instruction>(programCount);programData=reserve<double>(programCount);
  programValues=reserve<double>(programCapacity);adjoints=reserve<double>(programCapacity);
  projectionCount=dependentCount;seedCount=initialSeedCount;projectEnabled=false;
  projections=reserve<i32>(projectionCount*3);seedIndices=reserve<i32>(seedCount);seedValues=reserve<double>(seedCount);
  projectionTrialValues=reserve<double>(projectionCount);
  swell::allocate(swellSources,swellRefs,swellDefinitions,swellPairs,swellRequests,swellSegments,swellSamples);
  sparse::allocate(sparseEntries?activeCount:0,sparseEntries);
  bytes=cursor;
  const u32 current=__builtin_wasm_memory_size(0);
  const u32 required=(bytes+65535)/65536;
  if (required>current) {
    const u32 capacity=required>current*2?required:current*2;
    if (__builtin_wasm_memory_grow(0, capacity-current)==static_cast<unsigned long>(-1)) return 0;
    ++grows;
  }
  void* arrays[]={x,parameters,constraints,constants,active,rowOffsets,columns,values,errors,
    groupStarts,groupColumns,groupOffsets,columnGroups,columnLocal,stats,instructions,programData,projections,seedIndices,seedValues,swell::integers,swell::numbers,sparse::order,sparse::cols};
  for(u32 i=0;i<24;++i) pointers[i]=reinterpret_cast<u32>(arrays[i]);
  ++topologyBuilds; status=Unchanged; phase=0;
  return 1;
}
extern "C" __attribute__((visibility("default"))) u32 buffer(i32 kind) { return kind>=0 && kind<24 ? pointers[kind] : 0; }
extern "C" __attribute__((visibility("default"))) u32 sparse_buffer(i32 kind) {
  return reinterpret_cast<u32>(kind==0?sparse::position:sparse::offsets);
}

// Returns residuals and exact local derivatives. Distance uses the same branch
// and denominator test as AnalyticalJacobians.js, with its local central
// difference fallback at nondifferentiable scale boundaries.
static bool evaluateConstraint(i32 index, double out[2], double jac[2][8], bool derivatives) {
  const auto &c=constraints[index]; const auto &k=constants[index];
  double q[8]; for(i32 j=0;j<8;++j) q[j]=coordinate(c.refs[j]);
  if(derivatives) for(i32 r=0;r<2;++r) for(i32 j=0;j<8;++j) jac[r][j]=0;
  out[0]=out[1]=0;
  const double t=c.parameter>=0?parameters[c.parameter]:k.target;
  switch(c.kind) {
    case Coincident: case Concentric:
      out[0]=q[0]-q[2]; out[1]=q[1]-q[3];
      if(derivatives) {jac[0][0]=jac[1][1]=1; jac[0][2]=jac[1][3]=-1;} break;
    case Horizontal: case Vertical: {
      const i32 a=c.kind==Horizontal?1:0; out[0]=q[a]-q[a+2];
      if(derivatives) {jac[0][a]=1; jac[0][a+2]=-1;} break;
    }
    case Fixed:
      out[0]=q[0]-k.fixedX; out[1]=q[1]-k.fixedY;
      if(derivatives) {jac[0][0]=jac[1][1]=1;} break;
    case HorizontalDistance: case VerticalDistance: {
      const i32 a=c.kind==HorizontalDistance?0:1;
      const double delta=q[a+2]-q[a]; const double s=k.orientation?k.orientation:(sign(delta)?sign(delta):1);
      out[0]=delta-s*t;
      if(derivatives) {jac[0][a]=-1; jac[0][a+2]=1;} break;
    }
    case Radius: case Diameter: {
      const double scale=c.kind==Diameter?2:1; out[0]=absd(q[0])*scale-t;
      if(derivatives) jac[0][0]=(sign(q[0])?sign(q[0]):1)*scale; break;
    }
    case Midpoint:
      out[0]=q[0]-(q[2]+q[4])/2; out[1]=q[1]-(q[3]+q[5])/2;
      if(derivatives) {jac[0][0]=jac[1][1]=1; jac[0][2]=jac[0][4]=jac[1][3]=jac[1][5]=-.5;} break;
    case Distance: case PointOnCircle: {
      const double dx=q[0]-q[2],dy=q[1]-q[3], m=dx*dx+dy*dy;
      const double radius=c.kind==PointOnCircle?absd(q[4]):t;
      const double desired=radius*radius, scale=maxd(1,maxd(m,desired));
      out[0]=(m-desired)/scale;
      if(c.rows==2) out[1]=mind(0,((q[2]-q[0])*k.directionX+(q[3]-q[1])*k.directionY)/maxd(1,absd(t)));
      if(derivatives) {
        const double fixedScale=maxd(1,desired), tol=1e-9*scale;
        if(c.kind==Distance && absd(m-fixedScale)<=tol && m!=desired) return false;
        const double dm=m>fixedScale?desired/(m*m):1/fixedScale;
        jac[0][0]=2*dx*dm; jac[0][1]=2*dy*dm; jac[0][2]=-jac[0][0]; jac[0][3]=-jac[0][1];
        if(c.kind==PointOnCircle) {
          // normalizedDifference in AnalyticalJacobians.js, including its
          // equal-magnitude tie and unit-scale finite-difference fallback.
          double sm=0, sd=0;
          if(absd(m-desired)<=tol && scale>1+tol) {}
          else if(absd(m-scale)<=tol) { if(absd(m-1)<=tol)return false; sm=1; }
          else if(absd(desired-scale)<=tol) { if(absd(desired-1)<=tol)return false; sd=1; }
          const double dm=1/scale-(m-desired)*sm/(scale*scale);
          const double dr=-1/scale-(m-desired)*sd/(scale*scale);
          jac[0][0]=2*dx*dm; jac[0][1]=2*dy*dm; jac[0][2]=-jac[0][0]; jac[0][3]=-jac[0][1];
          jac[0][4]=2*q[4]*dr;
        }
        if(c.rows==2 && out[1]<0) {
          const double s=maxd(1,absd(t));
          jac[1][0]=-k.directionX/s; jac[1][1]=-k.directionY/s;
          jac[1][2]=-jac[1][0]; jac[1][3]=-jac[1][1];
        }
      } break;
    }
    default: return false;
  }
  return true;
}
static bool evaluate(double* output, bool derivatives) {
  if(projectEnabled)for(i32 i=0;i<projectionCount;++i)x[projections[i*3]]=(x[projections[i*3+1]]+x[projections[i*3+2]])/2;
  if(derivatives) { zero(values,nz); analyticCount=fallbackCount=0; }
  for(i32 i=0;i<nc;++i) {
    if(constraints[i].kind==100) {if(!evaluateProgram(constraints[i],output,derivatives))return false;continue;}
    const auto &c=constraints[i]; double out[2], jac[2][8];
    const bool analytical=evaluateConstraint(i,out,jac,derivatives);
    for(i32 r=0;r<c.rows;++r) { if(!finite(out[r])) return false; output[c.row+r]=out[r]; }
    if(!derivatives) continue;
    if(analytical) ++analyticCount; else ++fallbackCount;
    for(i32 r=0;r<c.rows;++r) for(i32 entry=rowOffsets[c.row+r];entry<rowOffsets[c.row+r+1];++entry) {
      const i32 variable=active[columns[entry]];
      double value=0;
      if(analytical) {for(i32 local=0;local<8;++local) if(c.refs[local]==variable) value+=jac[r][local];}
      else {
        const double original=x[variable], delta=1e-6*maxd(1,absd(original));
        double positive[2],negative[2], unused[2][8];
        x[variable]=original+delta; evaluateConstraint(i,positive,unused,false);
        x[variable]=original-delta; evaluateConstraint(i,negative,unused,false); x[variable]=original;
        value=(positive[r]-negative[r])/(2*delta);
      }
      if(!finite(value)) return false;
      values[entry]=value;
    }
  }
  return true;
}
static void applyJ(const double* input,double* output) {
  for(i32 r=0;r<nr;++r) {double v=0; for(i32 e=rowOffsets[r];e<rowOffsets[r+1];++e) v+=values[e]*input[columns[e]]; output[r]=v;}
}
static void applyJT(const double* input,double* output) {
  zero(output,n);
  for(i32 r=0;r<nr;++r) for(i32 e=rowOffsets[r];e<rowOffsets[r+1];++e) output[columns[e]]+=values[e]*input[r];
}
static void precondition(const double* input,double* output) {
  zero(output,n);
  for(i32 g=0;g<ng;++g) {
    const i32 size=groupStarts[g+1]-groupStarts[g], start=groupStarts[g], base=groupOffsets[g];
    double work[8];
    if(factors[base]<0) { // Same diagonal fallback as the JS preconditioner.
      for(i32 r=0;r<size;++r) {const i32 col=groupColumns[start+r]; output[col]=input[col]/maxd(diagonal[col]+damping[col],1e-20);} continue;
    }
    for(i32 r=0;r<size;++r) {double v=input[groupColumns[start+r]];
      for(i32 c=0;c<r;++c) v-=factors[base+r*size+c]*work[c]; work[r]=v/factors[base+r*size+r];}
    for(i32 r=size-1;r>=0;--r) {double v=work[r];
      for(i32 c=r+1;c<size;++c) v-=factors[base+c*size+r]*output[groupColumns[start+c]];
      output[groupColumns[start+r]]=v/factors[base+r*size+r];}
  }
}
static void prepareLinear() {
  zero(normal,ne); zero(diagonal,n); zero(factors,ne); zero(step,n);
  for(i32 r=0;r<nr;++r) for(i32 a=rowOffsets[r];a<rowOffsets[r+1];++a) {
    const i32 ca=columns[a], g=columnGroups[ca], size=groupStarts[g+1]-groupStarts[g];
    diagonal[ca]+=values[a]*values[a];
    for(i32 b=a;b<rowOffsets[r+1];++b) {const i32 cb=columns[b]; if(columnGroups[cb]!=g) continue;
      const i32 base=groupOffsets[g], la=columnLocal[ca], lb=columnLocal[cb]; const double v=values[a]*values[b];
      normal[base+la*size+lb]+=v; if(la!=lb) normal[base+lb*size+la]+=v;
    }
  }
  for(i32 i=0;i<n;++i) damping[i]=lambda*maxd(absd(diagonal[i]),1)+1e-7;
  for(i32 g=0;g<ng;++g) {
    const i32 size=groupStarts[g+1]-groupStarts[g],base=groupOffsets[g]; bool good=true;
    for(i32 r=0;r<size && good;++r) for(i32 c=0;c<=r;++c) {
      double v=normal[base+r*size+c]; if(r==c) v+=damping[groupColumns[groupStarts[g]+r]];
      for(i32 k=0;k<c;++k) v-=factors[base+r*size+k]*factors[base+c*size+k];
      if(r==c) {if(!finite(v)||v<=1e-20) {good=false;break;} factors[base+r*size+c]=root(v);}
      else factors[base+r*size+c]=v/factors[base+c*size+c];
    }
    if(!good) factors[base]=-1;
  }
  applyJT(errors,rhs); for(i32 i=0;i<n;++i) rhs[i]=-rhs[i];
  const double rhsNorm=dot(rhs,rhs,n); targetNorm=maxd(1e-24,1e-18*rhsNorm);
  copy(residual,rhs,n); precondition(residual,z); copy(direction,z,n); rz=dot(residual,z,n);
  inner=0; lastLinearConverged=rhsNorm<=targetNorm;
}
static void updateStats() {
  stats[0]=status; stats[1]=outer; stats[2]=initialError; stats[3]=error;
  stats[4]=acceptedSteps; stats[5]=rejectedSteps; stats[6]=lastInner; stats[7]=totalInner;
  stats[8]=lastLinearConverged?1:0; stats[9]=analyticCount; stats[10]=fallbackCount;
  stats[11]=bytes; stats[12]=grows; stats[13]=topologyBuilds; stats[14]=lambda;
  stats[15]=root(dot(residual,residual,n));
  stats[16]=terminationReason;
  stats[17]=sparse::entries;
}
static i32 finish(i32 result, bool restore=false) {
  status=result; if(restore) {copy(x,initial,nv); error=initialError;} updateStats(); return status;
}
extern "C" __attribute__((visibility("default"))) i32 begin(double tolerance,i32 iterations,i32 preview) {
  if(!finite(tolerance)||tolerance<=0||iterations<0) return finish(Invalid);
  copy(initial,x,nv); zero(residual,n);projectEnabled=false;
  threshold=tolerance*tolerance; maxOuter=iterations; interactive=preview; lambda=.01;
  outer=acceptedSteps=rejectedSteps=inner=totalInner=lastInner=analyticCount=fallbackCount=terminationReason=0;
  lastLinearConverged=false; maxInner=n*2; if(maxInner<32)maxInner=32; if(maxInner>1000)maxInner=1000;
  if(!evaluate(errors,false)) {initialError=error=__builtin_inf();return finish(Invalid);}
  initialError=error=dot(errors,errors,nr); phase=0; status=Running;
  if(error<threshold) return finish(Unchanged);
  for(i32 i=0;i<seedCount;++i)x[seedIndices[i]]=seedValues[i];
  projectEnabled=true;
  if((seedCount || projectionCount) && !evaluate(errors,false))return finish(Invalid,true);
  error=dot(errors,errors,nr);copy(accepted,x,nv);
  if(error<threshold)return finish(Converged);
  if(!n) return finish(Failed,true);
  updateStats(); return status;
}
static bool rejectLinear() {
  ++rejectedSteps; lambda*=10; phase=0;
  if(!finite(lambda)||lambda>1e12) {terminationReason=1;finish(interactive?Preview:MaxIterations,!interactive);return false;} return true;
}
extern "C" __attribute__((visibility("default"))) i32 advance(i32 workBudget) {
  // Work is bounded by sparse operations, not a callback/clock read per row.
  // PCG and LM both retain their state across calls; JS never runs either loop.
  long long work=0; if(workBudget<1)workBudget=1;
  while(status==Running) {
    if(phase==0) {
      if(outer>=maxOuter) return finish(interactive?Preview:MaxIterations,!interactive);
      ++outer;
      if(!evaluate(errors,true)) return finish(Invalid,true);
      if(sparse::count){if(!sparse::assemble()){if(!rejectLinear())return status;continue;}phase=3;}
      else {prepareLinear();phase=1;}
      work+=nz*8LL+n*8LL;
    } else if(phase==1) {
      if(!lastLinearConverged && inner<maxInner) {
        ++inner; ++totalInner; applyJ(direction,rowWork); applyJT(rowWork,product);
        for(i32 i=0;i<n;++i) product[i]+=damping[i]*direction[i];
        const double curvature=dot(direction,product,n);
        if(!finite(curvature)||curvature<=1e-30) {if(!rejectLinear())return status;continue;}
        const double alpha=rz/curvature;
        if(!finite(alpha)) {if(!rejectLinear())return status;continue;}
        for(i32 i=0;i<n;++i) {step[i]+=alpha*direction[i];residual[i]-=alpha*product[i];}
        lastLinearConverged=dot(residual,residual,n)<=targetNorm;
        if(!lastLinearConverged) {
          precondition(residual,z); const double next=dot(residual,z,n);
          if(!finite(next)||absd(rz)<=1e-30) inner=maxInner;
          else {const double beta=next/rz;for(i32 i=0;i<n;++i)direction[i]=z[i]+beta*direction[i];rz=next;}
        }
        work+=nz*2LL+n*18LL+ne*2LL;
      } else phase=2;
    } else if(phase==3) {
      if(sparse::pivotRow<sparse::count){
        const i32 r=sparse::pivotRow, width=sparse::offsets[r+1]-sparse::offsets[r];
        if(!sparse::pivot()){if(!rejectLinear())return status;continue;}
        work+=width*(long long)width;
      }else phase=4;
    } else if(phase==4) {
      if(!sparse::refine()){if(!rejectLinear())return status;continue;}
      if(lastLinearConverged || sparse::refinements>=3)phase=2;
      work+=nz*2LL+sparse::entries*4LL+n*8LL;
    } else {
      lastInner=inner;
      for(i32 i=0;i<n;++i) x[active[i]]=accepted[active[i]]+step[i];
      const bool valid=evaluate(candidate,false); const double next=valid?dot(candidate,candidate,nr):__builtin_inf();
      if(finite(next)&&next<error) {
        copy(accepted,x,nv);copy(errors,candidate,nr);error=next;++acceptedSteps;lambda=maxd(1e-12,lambda/10);
        if(error<threshold) return finish(Converged);
        // Accepted small corrections can still converge at tight tolerances.
        // Failed improvement is bounded by rejectLinear() and the iteration budget.
        phase=0;
      } else {copy(x,accepted,nv);if(!rejectLinear())return status;}
      work+=nc*16LL;
    }
    if(work>=workBudget) break;
  }
  updateStats();return status;
}
extern "C" __attribute__((visibility("default"))) i32 cancel(i32 keepPreview) {
  return finish(keepPreview?Preview:Cancelled,!keepPreview);
}
extern "C" __attribute__((visibility("default"))) i32 linearize() {return evaluate(errors,true)?1:0;}
extern "C" __attribute__((visibility("default"))) i32 abi_version() {return 4;}
