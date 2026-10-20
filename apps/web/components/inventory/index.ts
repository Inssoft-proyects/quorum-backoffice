/**
 * Marbetes inventory redesign (maquette v2 + v3) — barrel export.
 *
 * Re-exports the components used by `app/(authed)/marbetes/_components/*`
 * and the rest of the inventory screens. Adding a new component here
 * keeps the rest of the app from reaching into individual files in this
 * folder.
 *
 * The donut chart was retired with the metric-card rework
 * (`odd/tasks/backoffice-ui-canon.md`, T7): the cards now render a compact
 * proportional bar, so `DonutChart` and its type are no longer exported.
 */

export { MetricBar } from './metric-bar';
export type { MetricBarProps, MetricBarSegment } from './metric-bar';

export { StatusChip } from './status-chip';
export type { StatusChipProps, StatusChipVariant } from './status-chip';

export { IdBadge } from './id-badge';
export type { IdBadgeProps } from './id-badge';

export { MaskedNumber } from './masked-number';
export type { MaskedNumberProps } from './masked-number';

export { MetricCard } from './metric-card';
export type { MetricCardProps } from './metric-card';

export { SortHeader } from './sort-header';
export type { SortHeaderProps, SortState } from './sort-header';

export { Pagination } from './pagination';
export type { PaginationProps, PageSize } from './pagination';

export { AddMarbeteDialog } from './add-marbete-dialog';
export type { AddMarbeteDialogProps } from './add-marbete-dialog';

export { RevealMarbeteDialog } from './reveal-marbete-dialog';
export type { RevealMarbeteDialogProps } from './reveal-marbete-dialog';

export { RevokeMarbeteDialog } from './revoke-marbete-dialog';
export type { RevokeMarbeteDialogProps } from './revoke-marbete-dialog';

export { BulkUploadDialog } from './bulk-upload-dialog';
export type { BulkUploadDialogProps } from './bulk-upload-dialog';

export { BulkUploadDropzone, formatFileSize } from './bulk-upload-dropzone';
export type { BulkUploadDropzoneProps, SelectedFile } from './bulk-upload-dropzone';

export { BulkUploadProcessingOverlay } from './bulk-upload-processing-overlay';
export type {
  BulkProcessingStage,
  BulkProcessingStageStatus,
  BulkUploadProcessingOverlayProps,
} from './bulk-upload-processing-overlay';

export { BulkUploadResult } from './bulk-upload-result';
export type { BulkUploadResultProps } from './bulk-upload-result';
