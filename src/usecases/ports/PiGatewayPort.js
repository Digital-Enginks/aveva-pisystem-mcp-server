export class PiGatewayPort {
  async readCurrentValue(stream, identity, signal) {
    throw new Error('Method not implemented: readCurrentValue');
  }

  async readRecorded(stream, timeRange, boundaryType, filterExpression, includeFiltered, desiredUnits, paging, identity, signal) {
    throw new Error('Method not implemented: readRecorded');
  }

  async readInterpolated(stream, timeRange, interval, syncTime, syncTimeBoundaryType, filterExpression, desiredUnits, identity, signal) {
    throw new Error('Method not implemented: readInterpolated');
  }

  async readSummary(stream, timeRange, summaryTypes, calculationBasis, timeType, summaryDuration, sampleType, sampleInterval, filterExpression, identity, signal) {
    throw new Error('Method not implemented: readSummary');
  }

  async readPlot(stream, timeRange, intervals, identity, signal) {
    throw new Error('Method not implemented: readPlot');
  }

  async resolveMetadata(webIdOrPath, identity, signal) {
    throw new Error('Method not implemented: resolveMetadata');
  }

  async submitBatch(batchPlan, identity, signal) {
    throw new Error('Method not implemented: submitBatch');
  }

  async writeValues(writeRequests, updateOption, bufferOption, identity, signal) {
    throw new Error('Method not implemented: writeValues');
  }
}
