// The reference CompiledConstraintSystem's bounded sparse LDL transpose solve.
// Symbolic order/fill is packed once by the adapter. Numeric work is resident.
namespace sparse {
static i32 count, entries, pivotRow, refinements;
static i32 *order, *position, *offsets, *cols;
static double *matrix, *factor, *pivots, *work;
static void allocate(i32 size, i32 fill) {
  count=size; entries=fill;
  order=reserve<i32>(count); position=reserve<i32>(count);
  offsets=reserve<i32>(count+1); cols=reserve<i32>(entries);
  matrix=reserve<double>(entries); factor=reserve<double>(entries);
  pivots=reserve<double>(count); work=reserve<double>(count);
}
static i32 slot(i32 a,i32 b) {
  if(a>b){const i32 t=a;a=b;b=t;}
  i32 lo=offsets[a], hi=offsets[a+1];
  while(lo<hi){const i32 m=lo+(hi-lo)/2;if(cols[m]<b)lo=m+1;else hi=m;}
  return lo<offsets[a+1] && cols[lo]==b ? lo : -1;
}
static bool assemble() {
  zero(matrix,entries);zero(step,n);zero(rhs,n);
  for(i32 r=0;r<nr;++r)for(i32 a=rowOffsets[r];a<rowOffsets[r+1];++a){
    const i32 ca=columns[a];rhs[ca]-=values[a]*errors[r];
    for(i32 b=a;b<rowOffsets[r+1];++b){
      const i32 target=slot(position[ca],position[columns[b]]);
      if(target<0)return false;
      matrix[target]+=values[a]*values[b];
    }
  }
  for(i32 r=0;r<count;++r){
    damping[order[r]]=lambda*maxd(absd(matrix[offsets[r]]),1)+1e-7;
    matrix[offsets[r]]+=damping[order[r]];
  }
  targetNorm=maxd(1e-24,dot(rhs,rhs,n)*1e-18);
  pivotRow=0;refinements=0;inner=0;lastLinearConverged=false;
  return true;
}
static bool pivot() {
  const i32 r=pivotRow++, start=offsets[r], end=offsets[r+1];
  const double d=matrix[start]; if(!finite(d)||d<=0)return false;
  pivots[r]=d;
  for(i32 a=start+1;a<end;++a){
    const double f=matrix[a]/d;factor[a]=f;
    for(i32 b=a;b<end;++b){const i32 target=slot(cols[a],cols[b]);
      if(target<0)return false;matrix[target]-=f*matrix[b];}
  }
  return true;
}
static void substitute(const double* input,bool add) {
  for(i32 r=0;r<count;++r)work[r]=input[order[r]];
  for(i32 r=0;r<count;++r)for(i32 e=offsets[r]+1;e<offsets[r+1];++e)work[cols[e]]-=factor[e]*work[r];
  for(i32 r=0;r<count;++r)work[r]/=pivots[r];
  for(i32 r=count-1;r>=0;--r)for(i32 e=offsets[r]+1;e<offsets[r+1];++e)work[r]-=factor[e]*work[cols[e]];
  for(i32 r=0;r<count;++r)step[order[r]]=(add?step[order[r]]:0)+work[r];
}
// One refinement per resumable work chunk, using the original sparse operator.
static bool refine() {
  if(!refinements)substitute(rhs,false);else substitute(residual,true);
  applyJ(step,rowWork);applyJT(rowWork,product);
  for(i32 c=0;c<n;++c){if(!finite(step[c]))return false;residual[c]=rhs[c]-product[c]-damping[c]*step[c];}
  lastLinearConverged=dot(residual,residual,n)<=targetNorm;
  ++refinements;++inner;++totalInner;
  return true;
}
}
