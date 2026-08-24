const config = require("../config");

/**
 * Strict Evidence-Based Employee Count Verification Service
 * 
 * Rules:
 * 1. Configurable employee threshold via .env (MIN_EMPLOYEE_COUNT, default: 30).
 *    If MIN_EMPLOYEE_COUNT=0 or disabled/false/null, employee count is optional and won't block qualification.
 * 2. Source Priority: LinkedIn (Primary) -> Official Website / About / Careers / Directory (Secondary).
 * 3. Range handling when threshold is enabled (e.g., 30):
 *    - 51-200, 201-500, 501-1000, 1001-5000, 10000+ -> ACCEPT (min >= threshold)
 *    - 1-10 -> REJECT (max < threshold)
 *    - 11-50, 20-40 -> NEED_MORE_VERIFICATION (requires credible secondary source)
 * 4. Multi-source resolution:
 *    - If LinkedIn is 11-50 and secondary source confirms 42 or 35 -> ACCEPT
 *    - If LinkedIn is 11-50 and secondary source is 25 or 18 -> REJECT
 *    - If sources conflict irreconcilably (e.g. 51-200 on LinkedIn vs 18 on website) -> CONFLICTING
 * 5. Zero guessing: No inference from revenue, products, clients, followers, or unbacked AI text.
 */

class EmployeeVerifier {
  /**
   * Helper to get active threshold
   */
  getThreshold(overrideThreshold = undefined) {
    if (overrideThreshold !== undefined) {
      if (overrideThreshold === null || overrideThreshold === false || overrideThreshold <= 0) return null;
      return typeof overrideThreshold === "number" ? overrideThreshold : parseInt(overrideThreshold, 10);
    }
    return config.minEmployeeCount;
  }

  /**
   * Extracts employee headcount evidence from text / HTML content.
   * @param {string} text - HTML or plain text from website, about page, or directory profile
   * @param {string} sourceName - Source name (e.g. "LinkedIn", "Official Website Homepage", "Shopify Partner Profile")
   * @param {string} sourceUrl - URL where evidence was found
   * @param {number|null} customThreshold - Optional custom threshold override
   * @returns {{
   *   exactCount: number | null,
   *   minCount: number | null,
   *   maxCount: number | null,
   *   range: string | null,
   *   source: string,
   *   sourceUrl: string | null,
   *   evidenceText: string | null,
   *   status: 'QUALIFIED' | 'REJECTED' | 'NEED_MORE_VERIFICATION' | 'UNKNOWN',
   *   reason: string
   * }}
   */
  parseHeadcountEvidence(text, sourceName = "Website", sourceUrl = null, customThreshold = undefined) {
    const threshold = this.getThreshold(customThreshold);

    if (!text || typeof text !== "string") {
      return {
        exactCount: null,
        minCount: null,
        maxCount: null,
        range: null,
        source: sourceName,
        sourceUrl,
        evidenceText: null,
        status: threshold ? "UNKNOWN" : "QUALIFIED",
        reason: threshold ? "No text provided for headcount verification" : "Employee threshold is optional/disabled"
      };
    }

    const cleanText = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    // 1. Check Range Patterns FIRST so ranges like "51-200 employees" or "11-50 employees" are not misparsed as single numbers
    const rangePatterns = [
      /(?:company\s*size\s*:\s*|headcount\s*:\s*|size\s*:\s*)?(\d{1,3}(?:,\d{3})*)\s*(?:-|to|–|—)\s*(\d{1,3}(?:,\d{3})*)\s*(?:employees|people|staff|members|specialists|developers|engineers|designers|experts)?/i,
      /(\d{1,3}(?:,\d{3})*)\s*(?:-|to|–|—)\s*(\d{1,3}(?:,\d{3})*)\s*(?:employees|people|staff|members|specialists|developers|engineers|designers|experts)/i,
      /(\d{1,3}(?:,\d{3})*)\+\s*(?:employees|people|staff|members|specialists|developers|engineers|designers|experts)/i,
      /(?:company\s*size|size|headcount)\s*:\s*(\d{1,3}(?:,\d{3})*)\+/i
    ];

    for (const pattern of rangePatterns) {
      const match = cleanText.match(pattern);
      if (match) {
        if (match[2]) {
          // Range: e.g. "51-200" or "11-50" or "1-10" or "20-40"
          const lower = parseInt(match[1].replace(/,/g, ""), 10);
          const upper = parseInt(match[2].replace(/,/g, ""), 10);

          // Sanity check valid range numbers
          if (!isNaN(lower) && !isNaN(upper) && lower <= upper && lower > 0 && upper < 1000000) {
            const rangeStr = `${lower}-${upper}`;

            // If threshold is disabled (null or <= 0), any valid range is qualified
            if (!threshold || threshold <= 0) {
              return {
                exactCount: null,
                minCount: lower,
                maxCount: upper,
                range: rangeStr,
                source: sourceName,
                sourceUrl,
                evidenceText: match[0].trim(),
                status: "QUALIFIED",
                reason: `Recorded range: ${rangeStr} employees (threshold check disabled/optional)`
              };
            }

            if (lower >= threshold) {
              // Lower bound is >= threshold (e.g. 51-200 >= 30), unconditionally QUALIFIED
              return {
                exactCount: null,
                minCount: lower,
                maxCount: upper,
                range: rangeStr,
                source: sourceName,
                sourceUrl,
                evidenceText: match[0].trim(),
                status: "QUALIFIED",
                reason: `Verified range: ${rangeStr} employees (lower bound ${lower} >= ${threshold})`
              };
            }

            if (upper < threshold) {
              // Upper bound is strictly < threshold (e.g. 1-10 < 30), unconditionally REJECTED
              return {
                exactCount: null,
                minCount: lower,
                maxCount: upper,
                range: rangeStr,
                source: sourceName,
                sourceUrl,
                evidenceText: match[0].trim(),
                status: "REJECTED",
                reason: `Range ${rangeStr} employees is < ${threshold} (Rejected)`
              };
            }

            // Ambiguous range spanning across threshold (e.g. 11-50, 20-40 with threshold 30): Needs more verification!
            return {
              exactCount: null,
              minCount: lower,
              maxCount: upper,
              range: rangeStr,
              source: sourceName,
              sourceUrl,
              evidenceText: match[0].trim(),
              status: "NEED_MORE_VERIFICATION",
              reason: `Range ${rangeStr} spans below and above ${threshold} threshold (Needs secondary verification)`
            };
          }
        } else if (match[1]) {
          // Single bound e.g. "50+ employees", "10,000+ employees", "30+ employees"
          const bound = parseInt(match[1].replace(/,/g, ""), 10);
          if (!isNaN(bound) && bound > 0) {
            const isQualified = !threshold || bound >= threshold;
            return {
              exactCount: null,
              minCount: bound,
              maxCount: null,
              range: `${bound}+`,
              source: sourceName,
              sourceUrl,
              evidenceText: match[0].trim(),
              status: isQualified ? "QUALIFIED" : "NEED_MORE_VERIFICATION",
              reason: isQualified
                ? `Verified headcount: ${bound}+ (${threshold ? `>= ${threshold} threshold met` : "threshold optional"})`
                : `Single bound ${bound}+ is below threshold ${threshold} (Needs secondary verification)`
            };
          }
        }
      }
    }

    // 2. Check Exact Number + Employees / Team / People patterns
    const exactPatterns = [
      /(?:team|company|workforce|staff|headcount)\s*(?:of|has|is|consists of|with)\s*(?:over|more than|approx|around|approximately)?\s*(\d{1,5})\+?\s*(?:full-time\s*)?(?:employees|team members|developers|engineers|designers|specialists|professionals|consultants|staff|people)/i,
      /(?:our\s*(?:in-house\s*|boutique\s*)?team\s*(?:has|consists of)|we\s*have\s*(?:a\s*)?(?:strong\s*)?(?:workforce|team|staff)\s*of)\s*(\d{1,5})\+?\s*(?:full-time\s*)?(?:employees|team members|developers|engineers|designers|specialists|professionals|consultants|staff|people)?/i,
      /(?:over|more than)\s*(\d{1,5})\s*(?:team members|employees|developers|engineers|designers|people|professionals)/i,
      /(?<!\d\s*-\s*)(?<!\d\s*to\s*)(\d{1,5})\+?\s*(?:full-time\s*)?(?:employees|team members|developers|engineers|designers|specialists|shopify experts|professionals|consultants|people)\s*(?:globally|worldwide|in-house|across|on board|strong)/i,
      /(?:size|headcount)\s*(?:of|:)\s*(\d{1,5})\+?(?!\s*-\s*\d)/i
    ];

    for (const pattern of exactPatterns) {
      const match = cleanText.match(pattern);
      if (match && match[1]) {
        const count = parseInt(match[1].replace(/,/g, ""), 10);
        if (!isNaN(count) && count > 0) {
          const isPlus = match[0].includes("+") || /over|more than/i.test(match[0]);
          const isQualified = !threshold || count >= threshold;
          return {
            exactCount: isPlus ? null : count,
            minCount: count,
            maxCount: isPlus ? null : count,
            range: isPlus ? `${count}+` : null,
            source: sourceName,
            sourceUrl,
            evidenceText: match[0].trim(),
            status: isQualified ? "QUALIFIED" : "REJECTED",
            reason: isQualified
              ? `Verified exact headcount: ${count}${isPlus ? "+" : ""} (${threshold ? `>= ${threshold} threshold met` : "threshold optional"})`
              : `Exact headcount ${count} is < ${threshold} (Rejected)`
          };
        }
      }
    }

    // 3. Unverified / Unknown
    return {
      exactCount: null,
      minCount: null,
      maxCount: null,
      range: null,
      source: sourceName,
      sourceUrl,
      evidenceText: null,
      status: threshold ? "UNKNOWN" : "QUALIFIED",
      reason: threshold
        ? "No credible headcount evidence found in provided source"
        : "Employee count not found, but threshold verification is disabled/optional"
    };
  }

  /**
   * Safe qualification & multi-source resolution function.
   * Priority: Primary (LinkedIn) -> Secondary (Official Website / Careers / About / Directory).
   *
   * @param {object|null} primary - Evidence from primary source (LinkedIn)
   * @param {object|null} secondary - Evidence from secondary source (Website / About / Careers / Directory)
   * @param {number|null} customThreshold - Optional custom threshold override
   * @returns {{
   *   isQualified: boolean,
   *   employee_count: number | null,
   *   employee_count_min: number | null,
   *   employee_count_max: number | null,
   *   employee_size_range: string | null,
   *   employee_count_source: string | null,
   *   employee_count_source_url: string | null,
   *   employee_count_verified: number,
   *   employee_count_verified_at: string,
   *   employee_count_status: 'QUALIFIED' | 'REJECTED' | 'UNCERTAIN' | 'CONFLICTING' | 'UNKNOWN' | 'NEED_MORE_VERIFICATION',
   *   reason: string
   * }}
   */
  evaluateMultiSource(primary = null, secondary = null, customThreshold = undefined) {
    const threshold = this.getThreshold(customThreshold);
    const timestamp = new Date().toISOString();

    // If threshold is disabled / optional (null or <= 0), company is always qualified
    if (!threshold || threshold <= 0) {
      const anyEvidence = (primary && primary.status !== "UNKNOWN") ? primary : (secondary && secondary.status !== "UNKNOWN" ? secondary : null);
      if (anyEvidence) {
        return {
          isQualified: true,
          employee_count: anyEvidence.exactCount || anyEvidence.minCount,
          employee_count_min: anyEvidence.minCount,
          employee_count_max: anyEvidence.maxCount,
          employee_size_range: anyEvidence.range,
          employee_count_source: anyEvidence.source,
          employee_count_source_url: anyEvidence.sourceUrl,
          employee_count_verified: 1,
          employee_count_verified_at: timestamp,
          employee_count_status: "QUALIFIED",
          reason: `Headcount recorded as ${anyEvidence.range || anyEvidence.exactCount || anyEvidence.minCount} (Threshold check optional)`
        };
      }
      return {
        isQualified: true,
        employee_count: null,
        employee_count_min: null,
        employee_count_max: null,
        employee_size_range: null,
        employee_count_source: null,
        employee_count_source_url: null,
        employee_count_verified: 0,
        employee_count_verified_at: timestamp,
        employee_count_status: "QUALIFIED",
        reason: "Employee size check is disabled/optional via configuration"
      };
    }

    const unverifiedResult = (status = "UNKNOWN", reason = "Employee count not verified") => ({
      isQualified: false,
      employee_count: null,
      employee_count_min: null,
      employee_count_max: null,
      employee_size_range: null,
      employee_count_source: null,
      employee_count_source_url: null,
      employee_count_verified: 0,
      employee_count_verified_at: timestamp,
      employee_count_status: status,
      reason
    });

    const prim = primary && primary.status !== "UNKNOWN" ? primary : null;
    const sec = secondary && secondary.status !== "UNKNOWN" ? secondary : null;

    // Case 1: Primary (LinkedIn) provides conclusive proof
    if (prim) {
      if (prim.status === "QUALIFIED") {
        // Check if secondary directly contradicts with < threshold
        if (sec && sec.status === "REJECTED" && ((sec.exactCount !== null && sec.exactCount < threshold) || (sec.maxCount !== null && sec.maxCount < threshold))) {
          // Direct contradiction: LinkedIn claimed >= threshold, but secondary claimed < threshold
          return {
            isQualified: false,
            employee_count: sec.exactCount || sec.maxCount,
            employee_count_min: prim.minCount,
            employee_count_max: prim.maxCount,
            employee_size_range: prim.range,
            employee_count_source: `${prim.source} / ${sec.source}`,
            employee_count_source_url: prim.sourceUrl || sec.sourceUrl,
            employee_count_verified: 0,
            employee_count_verified_at: timestamp,
            employee_count_status: "CONFLICTING",
            reason: `Conflicting evidence: ${prim.source} says ${prim.range || prim.minCount} but ${sec.source} says ${sec.exactCount || sec.maxCount}`
          };
        }

        const exactOrMin = prim.exactCount !== null ? prim.exactCount : prim.minCount;
        return {
          isQualified: true,
          employee_count: exactOrMin,
          employee_count_min: prim.minCount,
          employee_count_max: prim.maxCount,
          employee_size_range: prim.range,
          employee_count_source: prim.source,
          employee_count_source_url: prim.sourceUrl,
          employee_count_verified: 1,
          employee_count_verified_at: timestamp,
          employee_count_status: "QUALIFIED",
          reason: prim.reason
        };
      }

      if (prim.status === "REJECTED") {
        // Primary is explicitly < threshold
        const exactOrVal = prim.exactCount !== null ? prim.exactCount : prim.maxCount;
        return {
          isQualified: false,
          employee_count: exactOrVal,
          employee_count_min: prim.minCount,
          employee_count_max: prim.maxCount,
          employee_size_range: prim.range,
          employee_count_source: prim.source,
          employee_count_source_url: prim.sourceUrl,
          employee_count_verified: 0,
          employee_count_verified_at: timestamp,
          employee_count_status: "REJECTED",
          reason: prim.reason
        };
      }

      // Case 2: Primary is NEED_MORE_VERIFICATION (e.g. 11-50, 20-40)
      if (prim.status === "NEED_MORE_VERIFICATION") {
        if (sec) {
          if (sec.status === "QUALIFIED") {
            // Secondary establishes >= threshold (e.g. 42 or 35 employees on website)
            const exactOrMin = sec.exactCount !== null ? sec.exactCount : sec.minCount;
            return {
              isQualified: true,
              employee_count: exactOrMin,
              employee_count_min: sec.minCount || prim.minCount,
              employee_count_max: sec.maxCount || prim.maxCount,
              employee_size_range: prim.range || sec.range,
              employee_count_source: `${prim.source} + ${sec.source}`,
              employee_count_source_url: sec.sourceUrl || prim.sourceUrl,
              employee_count_verified: 1,
              employee_count_verified_at: timestamp,
              employee_count_status: "QUALIFIED",
              reason: `${prim.source} indicates ${prim.range}; verified >= ${threshold} via ${sec.source} (${exactOrMin} employees)`
            };
          }

          if (sec.status === "REJECTED") {
            // Secondary establishes < threshold (e.g. 25 or 18 employees on website)
            const exactOrVal = sec.exactCount !== null ? sec.exactCount : sec.maxCount;
            return {
              isQualified: false,
              employee_count: exactOrVal,
              employee_count_min: sec.minCount,
              employee_count_max: sec.maxCount,
              employee_size_range: prim.range,
              employee_count_source: `${prim.source} + ${sec.source}`,
              employee_count_source_url: sec.sourceUrl || prim.sourceUrl,
              employee_count_verified: 0,
              employee_count_verified_at: timestamp,
              employee_count_status: "REJECTED",
              reason: `${prim.source} was ${prim.range}; resolved as < ${threshold} via ${sec.source} (${exactOrVal} employees)`
            };
          }
        }

        // Primary is 11-50 / 20-40, but no conclusive secondary evidence exists
        return {
          isQualified: false,
          employee_count: null,
          employee_count_min: prim.minCount,
          employee_count_max: prim.maxCount,
          employee_size_range: prim.range,
          employee_count_source: prim.source,
          employee_count_source_url: prim.sourceUrl,
          employee_count_verified: 0,
          employee_count_verified_at: timestamp,
          employee_count_status: "NEED_MORE_VERIFICATION",
          reason: `${prim.source} range ${prim.range} is uncertain without secondary verification (Not eligible)`
        };
      }
    }

    // Case 3: Primary was unavailable/unknown, but Secondary is available
    if (sec) {
      if (sec.status === "QUALIFIED") {
        const exactOrMin = sec.exactCount !== null ? sec.exactCount : sec.minCount;
        return {
          isQualified: true,
          employee_count: exactOrMin,
          employee_count_min: sec.minCount,
          employee_count_max: sec.maxCount,
          employee_size_range: sec.range,
          employee_count_source: sec.source,
          employee_count_source_url: sec.sourceUrl,
          employee_count_verified: 1,
          employee_count_verified_at: timestamp,
          employee_count_status: "QUALIFIED",
          reason: sec.reason
        };
      }

      if (sec.status === "REJECTED") {
        const exactOrVal = sec.exactCount !== null ? sec.exactCount : sec.maxCount;
        return {
          isQualified: false,
          employee_count: exactOrVal,
          employee_count_min: sec.minCount,
          employee_count_max: sec.maxCount,
          employee_size_range: sec.range,
          employee_count_source: sec.source,
          employee_count_source_url: sec.sourceUrl,
          employee_count_verified: 0,
          employee_count_verified_at: timestamp,
          employee_count_status: "REJECTED",
          reason: sec.reason
        };
      }

      if (sec.status === "NEED_MORE_VERIFICATION") {
        return {
          isQualified: false,
          employee_count: null,
          employee_count_min: sec.minCount,
          employee_count_max: sec.maxCount,
          employee_size_range: sec.range,
          employee_count_source: sec.source,
          employee_count_source_url: sec.sourceUrl,
          employee_count_verified: 0,
          employee_count_verified_at: timestamp,
          employee_count_status: "NEED_MORE_VERIFICATION",
          reason: `${sec.source} range ${sec.range} is uncertain (Not eligible)`
        };
      }
    }

    // Case 4: Completely unknown
    return unverifiedResult("UNKNOWN", "Employee count could not be verified from public sources");
  }

  /**
   * Helper for single text verification (backward compatible)
   * @param {string} text
   * @param {string} sourceName
   * @param {number|null} customThreshold
   * @returns {{ verifiedCount: number | null, source: string | null, isQualified: boolean, reason: string }}
   */
  verifyEmployeeCount(text, sourceName = "Website", customThreshold = undefined) {
    const evidence = this.parseHeadcountEvidence(text, sourceName, null, customThreshold);
    const evalResult = this.evaluateMultiSource(null, evidence, customThreshold);

    return {
      verifiedCount: evalResult.employee_count,
      source: evalResult.employee_count_source,
      isQualified: evalResult.isQualified,
      status: evalResult.employee_count_status,
      range: evalResult.employee_size_range,
      reason: evalResult.reason
    };
  }

  /**
   * Threshold check helper
   * @param {number|null|undefined} count
   * @param {number|null} customThreshold
   * @returns {boolean}
   */
  isCountQualified(count, customThreshold = undefined) {
    const threshold = this.getThreshold(customThreshold);
    if (!threshold || threshold <= 0) return true; // threshold disabled
    if (count === null || count === undefined || typeof count !== "number" || isNaN(count)) {
      return false;
    }
    return count >= threshold;
  }
}

module.exports = new EmployeeVerifier();
