output "region" {
  value = data.aws_region.current.name
}

output "account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "auth_table_name" {
  value = aws_dynamodb_table.auth.name
}

output "audit_table_name" {
  value = aws_dynamodb_table.audit.name
}

output "auth_kms_key_arn" {
  value = aws_kms_key.data.arn
}

output "audit_hmac_key_arn" {
  value = local.current_audit_hmac_key_arn
}

output "audit_hmac_key_arns_by_version" {
  value = {
    for version, key in aws_kms_key.audit_hmac : version => key.arn
  }
}

output "audit_hmac_verify_key_arns" {
  value = local.audit_hmac_verify_key_arns
}

output "oidc_secret_arn" {
  value     = local.oidc_secret_arn
  sensitive = true
}

output "readiness_evidence_secret_arn" {
  value     = local.readiness_secret_arn
  sensitive = true
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

output "evidence_bucket_name" {
  value = aws_s3_bucket.evidence.id
}