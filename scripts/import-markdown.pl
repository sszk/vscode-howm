#!/usr/bin/env perl

package Howm::MarkdownImport;

use strict;
use warnings;
use Encode qw(decode FB_CROAK LEAVE_SRC);
use Fcntl qw(O_WRONLY O_CREAT O_EXCL S_ISREG);
use File::Basename qw(basename);
use File::Path qw(make_path);
use File::Spec;

sub output_name {
    my ($source, $ctime) = @_;
    my $name = basename($source);
    my ($year, $month, $day) = $name =~ /\A([0-9]{4})([0-9]{2})([0-9]{2})/;
    die "filename must start with YYYYMMDD\n" unless defined $day;

    my @days = (0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31);
    $days[2] = 29 if $year % 4 == 0 && ($year % 100 != 0 || $year % 400 == 0);
    die "invalid date in filename: $year$month$day\n"
        unless $year >= 1 && $month >= 1 && $month <= 12
            && $day >= 1 && $day <= $days[$month];

    my $time = '000000';
    if (defined $ctime) {
        # JST has a fixed UTC+09:00 offset. Never consult the process timezone.
        my @jst = gmtime($ctime + 9 * 60 * 60);
        if (@jst && sprintf('%04d%02d%02d', $jst[5] + 1900, $jst[4] + 1, $jst[3]) eq "$year$month$day") {
            $time = sprintf('%02d%02d%02d', $jst[2], $jst[1], $jst[0]);
        }
    }
    return ($year, $month, "$year-$month-$day-$time.md");
}

sub copy_note {
    my ($destination, $source) = @_;
    my @stat = stat($source);
    die "cannot stat input: $!\n" unless @stat;
    die "input is not a regular file\n" unless S_ISREG($stat[2]);
    open my $input, '<:raw', $source or die "cannot open input: $!\n";
    @stat = stat($input);
    die "cannot stat input: $!\n" unless @stat;
    die "input is not a regular file\n" unless S_ISREG($stat[2]);
    my ($year, $month, $name) = output_name($source, $stat[10]);
    my $bytes = '';
    while (1) {
        my $length = read($input, my $chunk, 64 * 1024);
        die "cannot read input: $!\n" unless defined $length;
        last unless $length;
        $bytes .= $chunk;
    }
    close $input or die "cannot close input: $!\n";
    # Validate without changing the original bytes, BOM or line endings.
    eval { decode('UTF-8', $bytes, FB_CROAK | LEAVE_SRC); 1 }
        or die "input is not valid UTF-8\n";

    my $directory = File::Spec->catdir($destination, $year, $month);
    make_path($directory);
    (my $stem = $name) =~ s/\.md\z//;
    my ($output, $path);
    for (my $number = 0; ; $number++) {
        my $candidate = $number ? "$stem-$number.md" : $name;
        $path = File::Spec->catfile($directory, $candidate);
        # O_EXCL prevents overwriting files or following existing symlinks,
        # including when another importer creates the same name concurrently.
        last if sysopen($output, $path, O_WRONLY | O_CREAT | O_EXCL, 0666);
        next if $!{EEXIST};
        die "cannot create output '$path': $!\n";
    }
    my $written = eval {
        binmode $output, ':raw' or die "cannot set output mode: $!\n";
        print {$output} $bytes or die "cannot write output: $!\n";
        close $output or die "cannot close output: $!\n";
        1;
    };
    unless ($written) {
        my $error = $@;
        close $output;
        unlink $path or warn "cannot remove incomplete output '$path': $!\n";
        die $error;
    }
    return $path;
}

sub usage {
    return <<'HELP';
Usage: perl scripts/import-markdown.pl DESTINATION FILE [FILE ...]

Copy UTF-8 Markdown files whose names begin with YYYYMMDD into:
  DESTINATION/YYYY/MM/YYYY-MM-DD-HHMMSS.md

Use the input's ctime (inode change time) in JST (UTC+09:00) only when
its JST date matches YYYYMMDD. Otherwise use 000000. Existing names get
-1, -2, ... suffixes. Input files and Markdown contents are preserved.

Exit status: 0 = all copied, 1 = at least one failure, 2 = invalid arguments.
HELP
}

sub main {
    my @arguments = @_;
    if (@arguments == 1 && ($arguments[0] eq '--help' || $arguments[0] eq '-h')) {
        print usage();
        return 0;
    }
    if (@arguments < 2 || !length $arguments[0]) {
        print STDERR usage();
        return 2;
    }
    my $destination = shift @arguments;
    my ($copied, $failed) = (0, 0);
    for my $source (@arguments) {
        my $path = eval { copy_note($destination, $source) };
        if (defined $path) {
            print "$source -> $path\n";
            $copied++;
        } else {
            my $error = $@ || "unknown error\n";
            chomp $error;
            print STDERR "FAILED $source: $error\n";
            $failed++;
        }
    }
    print "Copied: $copied; Failed: $failed\n";
    return $failed ? 1 : 0;
}

exit main(@ARGV) unless caller;
1;
