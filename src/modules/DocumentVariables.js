import { arcSweepFromAngles } from './ArcGeometry.js';

export const DOCUMENT_APPLICATION_NAME = 'ParaMagic';
export const DOCUMENT_APPLICATION_VERSION = '0.1.0';

const clone = (value) => JSON.parse(JSON.stringify(value));

const dateValue = (value, fallback = new Date()) => {
  const date = value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? fallback.toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
};

const editableFields = [
  ['documentTitle', 'Document Title'],
  ['drawingNumber', 'Drawing Number'],
  ['revision', 'Revision'],
  ['revisionDescription', 'Revision Description'],
  ['approvalStatus', 'Approval Status'],
  ['author', 'Author'],
  ['designer', 'Designer'],
  ['checker', 'Checker'],
  ['approver', 'Approver'],
  ['company', 'Company'],
  ['project', 'Project'],
  ['customer', 'Customer'],
  ['jobNumber', 'Job Number'],
  ['partNumber', 'Part Number'],
  ['sheetSize', 'Sheet Size'],
  ['drawingScale', 'Drawing Scale'],
  ['projectionStandard', 'Projection Standard'],
  ['material', 'Material'],
  ['finish', 'Finish'],
  ['density', 'Density'],
  ['thickness', 'Thickness'],
  ['userName', 'User Name'],
];

export const DOCUMENT_VARIABLE_SPECS = Object.freeze([
  { name: 'FileName', label: 'File Name', key: 'fileName', readOnly: true },
  { name: 'FilePath', label: 'File Path', key: 'filePath', readOnly: true },
  { name: 'DocumentTitle', label: 'Document Title', key: 'documentTitle' },
  { name: 'DrawingNumber', label: 'Drawing Number', key: 'drawingNumber' },
  { name: 'Revision', label: 'Revision', key: 'revision' },
  { name: 'RevisionDescription', label: 'Revision Description', key: 'revisionDescription' },
  { name: 'ApprovalStatus', label: 'Approval Status', key: 'approvalStatus' },
  { name: 'RevisionDate', label: 'Revision Date', key: 'revisionDate', readOnly: true },
  { name: 'Author', label: 'Author', key: 'author' },
  { name: 'Designer', label: 'Designer', key: 'designer' },
  { name: 'Checker', label: 'Checker', key: 'checker' },
  { name: 'Approver', label: 'Approver', key: 'approver' },
  { name: 'Company', label: 'Company', key: 'company' },
  { name: 'Project', label: 'Project', key: 'project' },
  { name: 'Customer', label: 'Customer', key: 'customer' },
  { name: 'JobNumber', label: 'Job Number', key: 'jobNumber' },
  { name: 'PartNumber', label: 'Part Number', key: 'partNumber' },
  { name: 'CreatedDate', label: 'Created Date', key: 'createdDate', readOnly: true },
  { name: 'ModifiedDate', label: 'Modified Date', key: 'modifiedDate', readOnly: true },
  { name: 'PrintDate', label: 'Print Date', key: 'printDate', readOnly: true },
  { name: 'CurrentDate', label: 'Current Date', key: 'currentDate', readOnly: true },
  { name: 'Units', label: 'Units', key: 'units', readOnly: true },
  { name: 'SheetSize', label: 'Sheet Size', key: 'sheetSize' },
  { name: 'DrawingScale', label: 'Drawing Scale', key: 'drawingScale' },
  { name: 'ProjectionStandard', label: 'Projection Standard', key: 'projectionStandard' },
  { name: 'Material', label: 'Material', key: 'material' },
  { name: 'Finish', label: 'Finish', key: 'finish' },
  { name: 'Mass', label: 'Mass', key: 'mass', readOnly: true },
  { name: 'Density', label: 'Density', key: 'density' },
  { name: 'Thickness', label: 'Thickness', key: 'thickness' },
  { name: 'BoundingBoxWidth', label: 'Bounding Box Width', key: 'boundingBoxWidth', readOnly: true },
  { name: 'BoundingBoxHeight', label: 'Bounding Box Height', key: 'boundingBoxHeight', readOnly: true },
  { name: 'ApplicationName', label: 'Application Name', key: 'applicationName', readOnly: true },
  { name: 'ApplicationVersion', label: 'Application Version', key: 'applicationVersion', readOnly: true },
  { name: 'UserName', label: 'User Name', key: 'userName' },
]);

export const EDITABLE_DOCUMENT_FIELDS = Object.freeze(editableFields.map(([key]) => key));

export function normalizeDocumentMetadata(input = {}, now = new Date()) {
  const source = input && typeof input === 'object' ? input : {};
  const metadata = Object.fromEntries(editableFields.map(([key]) => [key, String(source[key] ?? '')]));
  return {
    ...metadata,
    createdDate: dateValue(source.createdDate, now),
    modifiedDate: dateValue(source.modifiedDate, now),
    revisionDate: dateValue(source.revisionDate, now),
  };
}

function entityPoints(entity) {
  if (!entity || entity.construction === true) return [];
  if (entity.type === 'line') return [entity.start, entity.end];
  if (entity.type === 'point') return [entity.point];
  if (entity.type === 'circle') {
    const radius = Math.abs(Number(entity.radius));
    return [
      entity.center,
      [entity.center?.[0] - radius, entity.center?.[1] - radius],
      [entity.center?.[0] + radius, entity.center?.[1] + radius],
    ];
  }
  if (entity.type === 'rect') {
    return [
      [entity.x, entity.y],
      [Number(entity.x) + Number(entity.width), entity.y],
      [Number(entity.x) + Number(entity.width), Number(entity.y) + Number(entity.height)],
      [entity.x, Number(entity.y) + Number(entity.height)],
    ];
  }
  if (entity.type === 'arc') {
    const points = [entity.start, entity.arcPoint, entity.end];
    if (Array.isArray(entity.center) && Number.isFinite(Number(entity.radius))) {
      const startAngle = Math.atan2(entity.start[1] - entity.center[1], entity.start[0] - entity.center[0]);
      const middleAngle = Math.atan2(entity.arcPoint[1] - entity.center[1], entity.arcPoint[0] - entity.center[0]);
      const endAngle = Math.atan2(entity.end[1] - entity.center[1], entity.end[0] - entity.center[0]);
      const sweep = arcSweepFromAngles(startAngle, endAngle, middleAngle, {
        major: typeof entity.major === 'boolean' ? entity.major : null,
        ccw: typeof entity.ccw === 'boolean' ? entity.ccw : null,
      });
      const normalize = (angle) => (angle + Math.PI * 2) % (Math.PI * 2);
      [0, Math.PI / 2, Math.PI, Math.PI * 1.5].forEach((angle) => {
        const relative = sweep.ccw
          ? normalize(angle - startAngle)
          : normalize(startAngle - angle);
        if (relative <= Math.abs(sweep.span) + 1e-7) {
          points.push([
            entity.center[0] + Math.cos(angle) * Math.abs(entity.radius),
            entity.center[1] + Math.sin(angle) * Math.abs(entity.radius),
          ]);
        }
      });
    }
    return points;
  }
  if (['polygon', 'polyline', 'curve'].includes(entity.type)) return entity.points || [];
  return [];
}

function geometryBounds(entities = []) {
  const points = entities.flatMap(entityPoints).filter((point) => (
    Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite)
  ));
  if (!points.length) return null;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

export function buildDocumentVariables({
  metadata = {},
  context = {},
  drawingUnit = 'in',
  entities = [],
  now = new Date(),
} = {}) {
  const normalized = normalizeDocumentMetadata(metadata, now);
  const bounds = geometryBounds(entities);
  const values = {
    ...normalized,
    fileName: String(context.fileName ?? ''),
    filePath: String(context.filePath ?? ''),
    printDate: dateValue(now, now),
    currentDate: dateValue(now, now),
    units: String(drawingUnit || 'in'),
    mass: '',
    boundingBoxWidth: bounds?.width ?? '',
    boundingBoxHeight: bounds?.height ?? '',
    applicationName: DOCUMENT_APPLICATION_NAME,
    applicationVersion: DOCUMENT_APPLICATION_VERSION,
  };
  return DOCUMENT_VARIABLE_SPECS.map((spec, order) => ({
    id: `document:${spec.name}`,
    name: spec.name,
    label: spec.label,
    value: values[spec.key] ?? '',
    expression: String(values[spec.key] ?? ''),
    kind: 'document',
    computed: Boolean(spec.readOnly),
    readOnly: Boolean(spec.readOnly),
    unit: spec.name.startsWith('BoundingBox') ? drawingUnit : null,
    error: null,
    order,
  }));
}

export function documentMetadataPatch(metadata, patch = {}, now = new Date()) {
  const current = normalizeDocumentMetadata(metadata, now);
  const next = { ...current };
  EDITABLE_DOCUMENT_FIELDS.forEach((key) => {
    if (patch[key] !== undefined) next[key] = String(patch[key] ?? '');
  });
  if (patch.revision !== undefined && String(patch.revision ?? '') !== current.revision) {
    next.revisionDate = dateValue(now, now);
  }
  next.modifiedDate = dateValue(now, now);
  return next;
}

export function cloneDocumentMetadata(metadata) {
  return clone(normalizeDocumentMetadata(metadata));
}
