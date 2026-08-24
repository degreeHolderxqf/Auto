/**
 * Strict Evidence-Based Employee Count Verification Service
 * Rules:
 * 1. Only companies verified with employee_count >= 30 (30 is valid) are qualified.
 * 2. Source Priority: LinkedIn (Primary) -> Official Website / About / Careers / Directory (Secondary).
 * 3. Range handling:
 *    - 51-200, 201-500, 501-1000, 1001-5000, 10000+ -> ACCEPT (min >= 30)
 *    - 1-10 -> REJECT (max < 30)
 *    - 11-50, 20-40 -> NEED_MORE_VERIFICATION (requires credible secondary source)
 * 4. Multi-source resolution:
 *    - If LinkedIn is 11-50 and secondary source confirms 42 or 35 -> ACCEPT
 *    - If LinkedIn is 11-50 and secondary source is 25 or 18 -> REJECT
 *    - If sources conflict irreconcilably (e.g. 51-200 on LinkedIn vs 18 on website) -> CONFLICTING
 * 5. Zero guessing: No inference from revenue, products, clients, followers, or unbacked AI text.
 */

class EmployeeVerifier {
  /**
   * Extracts employee headcount evidence from text / HTML content.
   * @param {string} text - HTML or plain text from website, about page, or directory profile
   * @param {string} sourceName - Source name (e.g. "LinkedIn", "Official Website Homepage", "Shopify Partner Profile")
   * @param {string} sourceUrl - URL where evidence was found
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
  parseHeadcountEvidence(text, sourceName = "Website", sourceUrl = null) {
    if (!text || typeof text !== "string") {
      return {
        exactCount: null,
        minCount: null,
        maxCount: null,
        range: null,
        source: sourceName,
        sourceUrl,
        evidenceText: null,
        status: "UNKNOWN",
        reason: "No text provided for headcount verification"
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

            if (lower >= 30) {
              // Lower bound is >= 30 (e.g. 51-200, 201-500, 30-50), unconditionally QUALIFIED
              return {
                exactCount: null,
                minCount: lower,
                maxCount: upper,
                range: rangeStr,
                source: sourceName,
                sourceUrl,
                evidenceText: match[0].trim(),
                status: "QUALIFIED",
                reason: `Verified range: ${rangeStr} employees (lower bound ${lower} >= 30)`
              };
            }

            if (upper < 30) {
              // Upper bound is strictly < 30 (e.g. 1-10, 1-29), unconditionally REJECTED
              return {
                exactCount: null,
                minCount: lower,
                maxCount: upper,
                range: rangeStr,
                source: sourceName,
                sourceUrl,
                evidenceText: match[0].trim(),
                status: "REJECTED",
                reason: `Range ${rangeStr} employees is < 30 (Rejected)`
              };
            }

            // Ambiguous range spanning across 30 (e.g. 11-50, 20-40): Needs more verification!
            return {
              exactCount: null,
              minCount: lower,
              maxCount: upper,
              range: rangeStr,
              source: sourceName,
              sourceUrl,
              evidenceText: match[0].trim(),
              status: "NEED_MORE_VERIFICATION",
              reason: `Range ${rangeStr} spans below and above 30 threshold (Needs secondary verification)`
            };
          }
        } else if (match[1]) {
          // Single bound e.g. "50+ employees", "10,000+ employees", "30+ employees"
          const bound = parseInt(match[1].replace(/,/g, ""), 10);
          if (!isNaN(bound) && bound > 0) {
            const isQualified = bound >= 30;
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
                ? `Verified headcount: ${bound}+ (>= 30 threshold met)`
                : `Single bound ${bound}+ is below threshold 30 (Needs secondary verification)`
            };
          }
        }
      }
    }

    // 2. Check Exact Number + Employees / Team / People patterns
    // e.g. "our team has 42 employees", "team of 30 specialists", "headcount: 35", "workforce of 45 engineers", "29 employees"
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
          const isQualified = count >= 30; // STRICT: 30 is valid!
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
              ? `Verified exact headcount: ${count}${isPlus ? "+" : ""} (>= 30 threshold met)`
              : `Exact headcount ${count} is < 30 (Rejected)`
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
      status: "UNKNOWN",
      reason: "No credible headcount evidence found in provided source"
    };
  }

  /**
   * Safe qualification & multi-source resolution function.
   * Priority: Primary (LinkedIn) -> Secondary (Official Website / Careers / About / Directory).
   *
   * @param {object|null} primary - Evidence from primary source (LinkedIn)
   * @param {object|null} secondary - Evidence from secondary source (Website / About / Careers / Directory)
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
  evaluateMultiSource(primary = null, secondary = null) {
    const timestamp = new Date().toISOString();

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
        // Check if secondary directly contradicts with < 30
        if (sec && sec.status === "REJECTED" && ((sec.exactCount !== null && sec.exactCount < 30) || (sec.maxCount !== null && sec.maxCount < 30))) {
          // Direct contradiction: LinkedIn claimed >= 30, but secondary claimed < 30
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
        // Primary is explicitly < 30 (e.g. 1-10 employees, or exact 25)
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
            // Secondary establishes >= 30 (e.g. 42 or 35 employees on website)
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
              reason: `${prim.source} indicates ${prim.range}; verified >= 30 via ${sec.source} (${exactOrMin} employees)`
            };
          }

          if (sec.status === "REJECTED") {
            // Secondary establishes < 30 (e.g. 25 or 18 employees on website)
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
              reason: `${prim.source} was ${prim.range}; resolved as < 30 via ${sec.source} (${exactOrVal} employees)`
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
   * @returns {{ verifiedCount: number | null, source: string | null, isQualified: boolean, reason: string }}
   */
  verifyEmployeeCount(text, sourceName = "Website") {
    const evidence = this.parseHeadcountEvidence(text, sourceName);
    const evalResult = this.evaluateMultiSource(null, evidence);

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
   * Strict count check helper
   * @param {number|null|undefined} count
   * @returns {boolean}
   */
  isCountQualified(count) {
    if (count === null || count === undefined || typeof count !== "number" || isNaN(count)) {
      return false;
    }
    return count >= 30; // 30 is valid!
  }
}

module.exports = new EmployeeVerifier();
