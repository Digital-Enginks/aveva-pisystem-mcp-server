import { Tvq } from '../domain/values/Tvq.js';
import { Quality } from '../domain/values/Quality.js';

/**
 * Normalises a raw PI Web API timed-value item to a Tvq instance.
 * @param {object} item - Raw PI value object
 * @param {string} [defaultUnits] - Fallback units abbreviation
 * @returns {Tvq} Normalized Tvq value object
 */
export function normalizeTvq(item, defaultUnits = null) {
  if (!item) return null;

  const quality = new Quality({
    // Default to NOT good when the upstream omits Good. Our stream projections
    // always request Good, so an absent value means an unprojected/error item
    // of unknown quality — labelling that as good would silently mislabel bad
    // data as trustworthy.
    good: item.Good !== undefined ? item.Good : false,
    questionable: item.Questionable !== undefined ? item.Questionable : false,
    substituted: item.Substituted !== undefined ? item.Substituted : false,
    annotated: item.Annotated !== undefined ? item.Annotated : false
  });

  // Normalize state/system value structures
  let normalizedValue = item.Value;
  if (item.Value && typeof item.Value === 'object') {
    // If it is a digital state or system state
    normalizedValue = {
      name: item.Value.Name,
      value: item.Value.Value,
      isSystem: Boolean(item.Value.IsSystem)
    };
  }

  return new Tvq({
    timestamp: item.Timestamp,
    value: normalizedValue,
    unitsAbbreviation: item.UnitsAbbreviation || defaultUnits,
    quality
  });
}
