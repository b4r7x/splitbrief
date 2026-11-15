import type { SeatIdentity } from '../../../core/providers/seat-identity.js';
import type { SummaryBase } from './build.js';

/** The seat fields a started run saves on its state; the state keeps no axis words. */
type StateSeatFields = Pick<
  SummaryBase,
  | 'plannerTool'
  | 'plannerModel'
  | 'plannerKind'
  | 'implementerTool'
  | 'implementerModel'
  | 'implementerKind'
  | 'reviewerTool'
  | 'reviewerModel'
  | 'reviewerKind'
  | 'reviewerSeat'
>;

/** A seat field with no value stays off the base: an older seat record reads it as undefined. */
export function summaryBaseFromIdentity(
  ident: SeatIdentity,
  base: Omit<SummaryBase, keyof SeatIdentity>,
): SummaryBase {
  return {
    ...base,
    plannerTool: ident.plannerTool,
    ...(ident.plannerModel !== undefined && { plannerModel: ident.plannerModel }),
    ...(ident.plannerKind !== undefined && { plannerKind: ident.plannerKind }),
    ...(ident.plannerAxes !== undefined && { plannerAxes: ident.plannerAxes }),
    implementerTool: ident.implementerTool,
    ...(ident.implementerModel !== undefined && { implementerModel: ident.implementerModel }),
    ...(ident.implementerKind !== undefined && { implementerKind: ident.implementerKind }),
    ...(ident.implementerAxes !== undefined && { implementerAxes: ident.implementerAxes }),
    ...(ident.reviewerTool !== undefined && { reviewerTool: ident.reviewerTool }),
    ...(ident.reviewerModel !== undefined && { reviewerModel: ident.reviewerModel }),
    ...(ident.reviewerKind !== undefined && { reviewerKind: ident.reviewerKind }),
    ...(ident.reviewerAxes !== undefined && { reviewerAxes: ident.reviewerAxes }),
    ...(ident.reviewerSeat !== undefined && { reviewerSeat: ident.reviewerSeat }),
  };
}

export function seatFieldsOf(summaryBase: SummaryBase): StateSeatFields {
  return {
    plannerTool: summaryBase.plannerTool,
    ...(summaryBase.plannerModel !== undefined && { plannerModel: summaryBase.plannerModel }),
    ...(summaryBase.plannerKind !== undefined && { plannerKind: summaryBase.plannerKind }),
    implementerTool: summaryBase.implementerTool,
    ...(summaryBase.implementerModel !== undefined && {
      implementerModel: summaryBase.implementerModel,
    }),
    ...(summaryBase.implementerKind !== undefined && {
      implementerKind: summaryBase.implementerKind,
    }),
    ...(summaryBase.reviewerTool !== undefined && { reviewerTool: summaryBase.reviewerTool }),
    ...(summaryBase.reviewerModel !== undefined && { reviewerModel: summaryBase.reviewerModel }),
    ...(summaryBase.reviewerKind !== undefined && { reviewerKind: summaryBase.reviewerKind }),
    ...(summaryBase.reviewerSeat !== undefined && { reviewerSeat: summaryBase.reviewerSeat }),
  };
}
