import { ReportStatistic } from './report-statistic.js';

export interface NotificationData {
    resultStatus: ReportStatistic;
    environment?: Map<string, string>;
    reportUrl?: string;
    reportName?: string;
    duration?: number;
    originalReportUrl?: string;
    reruns?: { attempt: number; url: string }[];
}
