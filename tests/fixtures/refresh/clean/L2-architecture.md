# L2 Architecture

## Overview

The system is a single web application with a small database. Pages are rendered on the server.

## Data flow

A volunteer scans a card and an item, the server records the loan, and the nightly job sends reminders.

## Technology choices

Plain server-side templates, one relational database and a nightly scheduled job.
